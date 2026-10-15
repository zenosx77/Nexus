-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0008 · relay budget + privilege hardening
-- Apply only after reviewing the target project; this migration is additive
-- and intentionally does not apply itself to any hosted database.
-- ═══════════════════════════════════════════════════════════════════════

-- Server-relayed browser requests have their own atomic UTC budget. The
-- existing worker table/RPC and worker defaults remain independent.
create table if not exists public.twelvedata_browser_credit_budget (
  scope          text primary key check (scope = 'browser'),
  usage_day      date not null,
  daily_calls    integer not null default 0 check (daily_calls >= 0),
  minute_bucket  timestamptz not null,
  minute_calls   integer not null default 0 check (minute_calls >= 0),
  updated_at     timestamptz not null default now()
);

-- Only the authenticated relay/worker may create retryable delivery rows.
-- Historic anonymous rows remain visible through the safe view but are not retried.
alter table public.telegram_deliveries
  add column if not exists server_managed boolean not null default false;

alter table public.twelvedata_browser_credit_budget enable row level security;
revoke all on table public.twelvedata_browser_credit_budget from public, anon, authenticated;
grant all on table public.twelvedata_browser_credit_budget to service_role;

create or replace function public.reserve_twelvedata_browser_credit(
  p_daily_limit integer,
  p_minute_limit integer,
  p_category text default 'scan',
  p_scan_reserve integer default 0
) returns jsonb
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
  v_minute_ceiling integer;
begin
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  v_minute := to_timestamp(floor(extract(epoch from v_now) / 60) * 60);

  if p_daily_limit is null or p_daily_limit < 0 or p_minute_limit is null or p_minute_limit < 0
     or p_scan_reserve is null or p_scan_reserve < 0
     or p_category is null or p_category not in ('scan', 'ticker', 'settlement') then
    raise exception 'credit limits or category are invalid';
  end if;

  insert into public.twelvedata_browser_credit_budget
    (scope, usage_day, daily_calls, minute_bucket, minute_calls)
  values ('browser', v_day, 0, v_minute, 0)
  on conflict (scope) do nothing;

  select usage_day, daily_calls, minute_bucket, minute_calls
    into v_usage_day, v_daily_calls, v_minute_bucket, v_minute_calls
    from public.twelvedata_browser_credit_budget
    where scope = 'browser'
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
    update public.twelvedata_browser_credit_budget
      set usage_day = v_usage_day, daily_calls = v_daily_calls,
          minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
      where scope = 'browser';
    return jsonb_build_object('allowed', false, 'reason', 'daily-limit',
      'daily_calls', v_daily_calls, 'minute_calls', v_minute_calls, 'retry_after_ms', v_retry_ms);
  end if;

  if p_category <> 'settlement' and v_daily_calls >= floor(p_daily_limit * 0.8) then
    v_retry_ms := greatest(0, ceil(extract(epoch from (((v_day + 1)::timestamp at time zone 'UTC') - v_now)) * 1000)::bigint);
    update public.twelvedata_browser_credit_budget
      set usage_day = v_usage_day, daily_calls = v_daily_calls,
          minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
      where scope = 'browser';
    return jsonb_build_object('allowed', false, 'reason', 'settlement-reserve',
      'daily_calls', v_daily_calls, 'minute_calls', v_minute_calls, 'retry_after_ms', v_retry_ms);
  end if;

  v_minute_ceiling := p_minute_limit;
  if p_category = 'ticker' then
    v_minute_ceiling := greatest(0, p_minute_limit - least(p_scan_reserve, p_minute_limit));
  end if;
  if v_minute_calls >= v_minute_ceiling then
    v_retry_ms := greatest(0, ceil(extract(epoch from ((v_minute_bucket + interval '1 minute') - v_now)) * 1000)::bigint);
    update public.twelvedata_browser_credit_budget
      set usage_day = v_usage_day, daily_calls = v_daily_calls,
          minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
      where scope = 'browser';
    return jsonb_build_object('allowed', false, 'reason', 'minute-limit',
      'daily_calls', v_daily_calls, 'minute_calls', v_minute_calls, 'retry_after_ms', v_retry_ms);
  end if;

  v_daily_calls := v_daily_calls + 1;
  v_minute_calls := v_minute_calls + 1;
  update public.twelvedata_browser_credit_budget
    set usage_day = v_usage_day, daily_calls = v_daily_calls,
        minute_bucket = v_minute_bucket, minute_calls = v_minute_calls, updated_at = v_now
    where scope = 'browser';

  return jsonb_build_object('allowed', true, 'reason', 'reserved',
    'daily_calls', v_daily_calls, 'minute_calls', v_minute_calls,
    'daily_limit', p_daily_limit, 'minute_limit', p_minute_limit);
end;
$$;

revoke all on function public.reserve_twelvedata_browser_credit(integer, integer, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_twelvedata_browser_credit(integer, integer, text, integer) to service_role;
revoke all on function public.reserve_twelvedata_credit(integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_twelvedata_credit(integer, integer) to service_role;

-- SECURITY DEFINER functions in migrations 0004/0006 must not retain the
-- PostgreSQL default PUBLIC EXECUTE grant. They are worker-only operations.
revoke all on function public.try_job_lock(text, text, integer) from public, anon, authenticated;
grant execute on function public.try_job_lock(text, text, integer) to service_role;
revoke all on function public.release_job_lock(text, text) from public, anon, authenticated;
grant execute on function public.release_job_lock(text, text) to service_role;
revoke all on function public.prune_market_candles(integer) from public, anon, authenticated;
grant execute on function public.prune_market_candles(integer) to service_role;
revoke all on function public.prune_operational_logs(integer) from public, anon, authenticated;
grant execute on function public.prune_operational_logs(integer) to service_role;
revoke all on function public.prune_risk_snapshots() from public, anon, authenticated;
grant execute on function public.prune_risk_snapshots() to service_role;
revoke all on function public.prune_job_locks() from public, anon, authenticated;
grant execute on function public.prune_job_locks() to service_role;

-- Safe read-only projection for operational status. Never expose raw provider
-- error messages, Telegram chat IDs, tokens, payloads, or service settings.
create or replace view public.v_ingestion_health_public as
select pair_code, kind, status, started_at, finished_at,
       candles_fetched, candles_upserted, gaps_detected, latency_ms,
       (error is not null) as has_error
from public.ingestion_runs;

-- Explicit browser permissions: shared public read/insert-only mirror remains
-- intentional; no anon/authenticated UPDATE/DELETE/TRUNCATE or admin writes.
grant usage on schema public to anon, authenticated, service_role;

revoke all on table public.currency_pairs from public, anon, authenticated;
revoke all on table public.market_candles from public, anon, authenticated;
revoke all on table public.market_features from public, anon, authenticated;
revoke all on table public.predictions from public, anon, authenticated;
revoke all on table public.trade_outcomes from public, anon, authenticated;
revoke all on table public.trade_outcome_revisions from public, anon, authenticated;
revoke all on table public.model_versions from public, anon, authenticated;
revoke all on table public.training_runs from public, anon, authenticated;
revoke all on table public.risk_snapshots from public, anon, authenticated;
revoke all on table public.ingestion_runs from public, anon, authenticated;
revoke all on table public.telegram_deliveries from public, anon, authenticated;
revoke all on table public.system_settings from public, anon, authenticated;
revoke all on table public.alert_log from public, anon, authenticated;
revoke all on table public.job_locks from public, anon, authenticated;
revoke all on table public.twelvedata_credit_budget from public, anon, authenticated;
revoke all on table public.v_market_freshness, public.v_prediction_accuracy,
  public.v_deliveries_public, public.v_ingestion_health_public from public, anon, authenticated;

-- The worker/trainer retain their server-side access (service_role bypasses RLS).
grant all on table public.currency_pairs, public.market_candles, public.market_features,
  public.predictions, public.trade_outcomes, public.trade_outcome_revisions,
  public.model_versions, public.training_runs, public.risk_snapshots,
  public.ingestion_runs, public.telegram_deliveries, public.system_settings,
  public.alert_log, public.job_locks, public.twelvedata_credit_budget,
  public.twelvedata_browser_credit_budget to service_role;

-- Public read set used by the app; user records intentionally remain a shared
-- public mirror (not owner-private). Keep writes narrowly insert-only.
grant select on table public.currency_pairs, public.market_candles, public.market_features,
  public.predictions, public.trade_outcomes, public.model_versions,
  public.risk_snapshots to anon, authenticated;
grant insert on table public.predictions to anon, authenticated;
grant select on table public.v_market_freshness, public.v_prediction_accuracy,
  public.v_deliveries_public, public.v_ingestion_health_public to anon, authenticated;

-- Browser delivery inserts are intentionally disabled: retryable rows are
-- created only by the authenticated relay using service_role. This prevents
-- anonymous callers from forging failed rows that the worker would send to a channel.
drop policy if exists deliveries_anon_insert on public.telegram_deliveries;

-- Remove policies that implied public access to operational/admin tables; the
-- worker uses service_role. Safe projections above serve required dashboard data.
drop policy if exists outcome_revisions_public_read on public.trade_outcome_revisions;
drop policy if exists training_public_read on public.training_runs;
drop policy if exists ingestion_public_read on public.ingestion_runs;
drop policy if exists alerts_public_read on public.alert_log;
drop policy if exists settings_public_read on public.system_settings;
