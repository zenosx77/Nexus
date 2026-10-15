-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0007 · persistent Twelve Data credit guard
-- Atomic worker-only request reservations; counters survive restarts and
-- are shared by all worker instances using the same Supabase project.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists twelvedata_credit_budget (
  scope          text primary key check (scope = 'worker'),
  usage_day      date not null,
  daily_calls    integer not null default 0 check (daily_calls >= 0),
  minute_bucket  timestamptz not null,
  minute_calls   integer not null default 0 check (minute_calls >= 0),
  updated_at     timestamptz not null default now()
);

alter table twelvedata_credit_budget enable row level security;
revoke all on table twelvedata_credit_budget from anon, authenticated;
grant all on table twelvedata_credit_budget to service_role;

create or replace function reserve_twelvedata_credit(p_daily_limit integer, p_minute_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_now timestamptz;
  v_day date;
  v_minute timestamptz;
  v_usage_day date;
  v_daily_calls integer;
  v_minute_bucket timestamptz;
  v_minute_calls integer;
  v_retry_ms bigint;
begin
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  v_minute := to_timestamp(floor(extract(epoch from v_now) / 60) * 60);

  if p_daily_limit is null or p_daily_limit < 0 or p_minute_limit is null or p_minute_limit < 0 then
    raise exception 'credit limits must be non-negative integers';
  end if;

  insert into twelvedata_credit_budget (scope, usage_day, daily_calls, minute_bucket, minute_calls)
  values ('worker', v_day, 0, v_minute, 0)
  on conflict (scope) do nothing;

  select usage_day, daily_calls, minute_bucket, minute_calls
    into v_usage_day, v_daily_calls, v_minute_bucket, v_minute_calls
    from twelvedata_credit_budget
    where scope = 'worker'
    for update;

  if v_usage_day <> v_day then
    v_usage_day := v_day;
    v_daily_calls := 0;
  end if;
  if v_minute_bucket <> v_minute then
    v_minute_bucket := v_minute;
    v_minute_calls := 0;
  end if;

  if v_daily_calls >= p_daily_limit then
    v_retry_ms := greatest(0, ceil(extract(epoch from (((v_day + 1)::timestamp at time zone 'UTC') - v_now)) * 1000)::bigint);
    update twelvedata_credit_budget
      set usage_day = v_usage_day, daily_calls = v_daily_calls,
          minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
      where scope = 'worker';
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily-limit', 'daily_calls', v_daily_calls,
      'minute_calls', v_minute_calls, 'retry_after_ms', v_retry_ms
    );
  end if;

  if v_minute_calls >= p_minute_limit then
    v_retry_ms := greatest(0, ceil(extract(epoch from ((v_minute_bucket + interval '1 minute') - v_now)) * 1000)::bigint);
    update twelvedata_credit_budget
      set usage_day = v_usage_day, daily_calls = v_daily_calls,
          minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
      where scope = 'worker';
    return jsonb_build_object(
      'allowed', false, 'reason', 'minute-limit', 'daily_calls', v_daily_calls,
      'minute_calls', v_minute_calls, 'retry_after_ms', v_retry_ms
    );
  end if;

  v_daily_calls := v_daily_calls + 1;
  v_minute_calls := v_minute_calls + 1;
  update twelvedata_credit_budget
    set usage_day = v_usage_day, daily_calls = v_daily_calls,
        minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
    where scope = 'worker';

  return jsonb_build_object(
    'allowed', true, 'reason', 'reserved', 'daily_calls', v_daily_calls,
    'minute_calls', v_minute_calls, 'daily_limit', p_daily_limit,
    'minute_limit', p_minute_limit
  );
end;
$$;

revoke all on function reserve_twelvedata_credit(integer, integer) from public;
grant execute on function reserve_twelvedata_credit(integer, integer) to service_role;
