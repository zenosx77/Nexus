-- REVIEW / EXPLICIT APPROVAL REQUIRED before applying to a hosted project.
-- Stop ALL account consumers first. Keep them stopped until updated clients,
-- read-only verification and the initial UTC-day quarantine have passed.
-- One shared account across every API key, worker and browser relay.
begin;

create table if not exists public.twelvedata_account_budget (
  account text primary key check (account = 'twelvedata'),
  usage_day date not null,
  daily_calls integer not null check (daily_calls between 0 and 700),
  recent_calls timestamptz[] not null default '{}'
    check (cardinality(recent_calls) <= 6 and array_position(recent_calls, null) is null),
  blocked_until timestamptz not null,
  updated_at timestamptz not null
);
alter table public.twelvedata_account_budget enable row level security;
revoke all on table public.twelvedata_account_budget from public, anon, authenticated, service_role;
grant select on table public.twelvedata_account_budget to service_role;
-- Account state must never be created on demand by a request: deleting it must
-- fail closed, not buy another 700 calls. Reapplication does not reset counters.
-- We cannot reconstruct unobserved historic account traffic. Exhaust the current
-- UTC day rather than assume it was unused. Keep a 61s cross-midnight quarantine.
insert into public.twelvedata_account_budget
  (account, usage_day, daily_calls, recent_calls, blocked_until, updated_at)
values ('twelvedata', (clock_timestamp() at time zone 'UTC')::date, 700, '{}',
        clock_timestamp() + interval '61 seconds', clock_timestamp())
on conflict (account) do nothing;

-- Preserve legacy per-scope counters as secondary, possibly stricter controls
-- and for audit; service credentials may read but may not reset any counter.
revoke all on table public.twelvedata_credit_budget,
  public.twelvedata_browser_credit_budget from public, anon, authenticated, service_role;
grant select on table public.twelvedata_credit_budget,
  public.twelvedata_browser_credit_budget to service_role;

create or replace function public.reserve_twelvedata_account_credit(
  p_scope text, p_daily_limit integer, p_minute_limit integer,
  p_category text default 'scan', p_scan_reserve integer default 0
) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  a public.twelvedata_account_budget%rowtype;
  v_now timestamptz;
  v_day date;
  v_midnight timestamptz;
  v_bucket timestamptz;
  v_recent timestamptz[];
  v_scope_day date;
  v_scope_daily integer;
  v_scope_bucket timestamptz;
  v_scope_minute integer;
  v_daily_limit integer;
  v_minute_limit integer;
  v_reason text;
  v_retry bigint := 0;
begin
  if p_scope is null or p_scope not in ('worker','browser')
     or p_daily_limit is null or p_daily_limit < 0
     or p_minute_limit is null or p_minute_limit < 0
     or p_category is null or p_category not in ('scan','ticker','settlement')
     or p_scan_reserve is null or p_scan_reserve < 0 then
    raise exception 'invalid quota arguments: limits must be non-negative';
  end if;
  -- This row lock serializes every scope/key/process for the entire transaction.
  -- Take database time AFTER acquiring it, never before waiting on another caller.
  select * into a from public.twelvedata_account_budget
    where account='twelvedata' for update;
  if not found then raise exception 'shared quota state unavailable'; end if;
  v_now := clock_timestamp();
  if v_now < a.updated_at then raise exception 'quota clock regressed'; end if;
  v_day := (v_now at time zone 'UTC')::date;
  v_midnight := (v_day + 1)::timestamp at time zone 'UTC';
  v_bucket := date_trunc('minute', v_now);
  if v_day > a.usage_day then a.daily_calls := 0; end if;
  if v_day < a.usage_day then raise exception 'quota day regressed'; end if;
  -- 61 seconds reserves a 1s dispatch allowance. The client discards slow or
  -- ambiguous reservations and never refunds them. Preserve these across midnight.
  select coalesce(array_agg(t order by t), '{}'::timestamptz[]) into v_recent
    from unnest(a.recent_calls) t where t > v_now - interval '61 seconds';
  v_daily_limit := least(700, p_daily_limit);
  v_minute_limit := least(6, p_minute_limit);
  if p_scope='browser' and p_category='ticker' then
    v_minute_limit := greatest(0, v_minute_limit - least(p_scan_reserve, v_minute_limit));
  end if;

  if p_scope='worker' then
    insert into public.twelvedata_credit_budget(scope,usage_day,minute_bucket)
      values ('worker',v_day,v_bucket) on conflict do nothing;
    select usage_day,daily_calls,minute_bucket,minute_calls
      into v_scope_day,v_scope_daily,v_scope_bucket,v_scope_minute
      from public.twelvedata_credit_budget where scope='worker' for update;
  else
    insert into public.twelvedata_browser_credit_budget(scope,usage_day,minute_bucket)
      values ('browser',v_day,v_bucket) on conflict do nothing;
    select usage_day,daily_calls,minute_bucket,minute_calls
      into v_scope_day,v_scope_daily,v_scope_bucket,v_scope_minute
      from public.twelvedata_browser_credit_budget where scope='browser' for update;
  end if;
  if v_scope_day > v_day or v_scope_bucket > v_bucket then raise exception 'scope clock regressed'; end if;
  if v_scope_day < v_day then v_scope_daily := 0; end if;
  if v_scope_bucket < v_bucket then v_scope_minute := 0; end if;

  if a.daily_calls >= 700 or v_scope_daily >= v_daily_limit then
    v_reason := 'daily-limit'; v_retry := ceil(extract(epoch from (v_midnight-v_now))*1000);
  elsif v_now < a.blocked_until then
    v_reason := 'minute-limit'; v_retry := ceil(extract(epoch from (a.blocked_until-v_now))*1000);
  elsif cardinality(v_recent) >= 6 then
    v_reason := 'minute-limit'; v_retry := ceil(extract(epoch from (v_recent[1]+interval '61 seconds'-v_now))*1000);
  elsif p_scope='browser' and p_category<>'settlement' and v_scope_daily >= floor(v_daily_limit*0.8) then
    v_reason := 'settlement-reserve'; v_retry := ceil(extract(epoch from (v_midnight-v_now))*1000);
  elsif v_scope_minute >= v_minute_limit then
    v_reason := 'minute-limit'; v_retry := ceil(extract(epoch from (v_bucket+interval '1 minute'-v_now))*1000);
  end if;

  if v_reason is null then
    a.daily_calls := a.daily_calls + 1;
    v_recent := array_append(v_recent, v_now);
    v_scope_daily := v_scope_daily + 1;
    v_scope_minute := v_scope_minute + 1;
  end if;
  update public.twelvedata_account_budget set usage_day=v_day,
    daily_calls=a.daily_calls, recent_calls=v_recent, updated_at=v_now
    where account='twelvedata';
  if p_scope='worker' then
    update public.twelvedata_credit_budget set usage_day=v_day,daily_calls=v_scope_daily,
      minute_bucket=v_bucket,minute_calls=v_scope_minute,updated_at=v_now where scope='worker';
  else
    update public.twelvedata_browser_credit_budget set usage_day=v_day,daily_calls=v_scope_daily,
      minute_bucket=v_bucket,minute_calls=v_scope_minute,updated_at=v_now where scope='browser';
  end if;
  return jsonb_build_object('guard_version',1,'account','twelvedata',
    'allowed',v_reason is null,'reason',coalesce(v_reason,'reserved'),
    'daily_calls',a.daily_calls,'minute_calls',cardinality(v_recent),
    'daily_limit',700,'minute_limit',6,'retry_after_ms',greatest(0,v_retry),
    'valid_for_ms',greatest(0,least(1000,floor(extract(epoch from (v_midnight-v_now))*1000))));
end;
$$;
revoke all on function public.reserve_twelvedata_account_credit(text,integer,integer,text,integer)
  from public, anon, authenticated;
grant execute on function public.reserve_twelvedata_account_credit(text,integer,integer,text,integer)
  to service_role;

-- No old-RPC bypass during rollout/rollback: both legacy entry points now share
-- the same account transaction and hard caps. Never restore the 0007/0008 bodies.
create or replace function public.reserve_twelvedata_credit(p_daily_limit integer,p_minute_limit integer)
returns jsonb language sql security definer set search_path = pg_catalog as $$
  select public.reserve_twelvedata_account_credit('worker',p_daily_limit,p_minute_limit,'scan',0);
$$;
create or replace function public.reserve_twelvedata_browser_credit(
  p_daily_limit integer,p_minute_limit integer,p_category text default 'scan',p_scan_reserve integer default 0
) returns jsonb language sql security definer set search_path = pg_catalog as $$
  select public.reserve_twelvedata_account_credit('browser',p_daily_limit,p_minute_limit,p_category,p_scan_reserve);
$$;
revoke all on function public.reserve_twelvedata_credit(integer,integer),
  public.reserve_twelvedata_browser_credit(integer,integer,text,integer) from public,anon,authenticated;
grant execute on function public.reserve_twelvedata_credit(integer,integer),
  public.reserve_twelvedata_browser_credit(integer,integer,text,integer) to service_role;

-- Read-only preflight capability/version check; does not reserve a credit.
create or replace function public.twelvedata_quota_status() returns jsonb
language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object('guard_version',1,'account','twelvedata',
    'daily_limit',700,'minute_limit',6,'rolling_window_seconds',61,
    'initialized',exists(select 1 from public.twelvedata_account_budget where account='twelvedata'));
$$;
revoke all on function public.twelvedata_quota_status() from public,anon,authenticated;
grant execute on function public.twelvedata_quota_status() to service_role;
commit;
