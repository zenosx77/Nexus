-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0006 · retention & housekeeping
-- 1-minute data across 30 pairs is ~1.3M rows/month — comfortable for
-- Postgres with the PK index. Retention keeps it bounded; archival to
-- Storage (compressed JSONL) is done by the worker before pruning when
-- archive_before_prune is enabled. Partitioning is deliberately NOT
-- introduced yet — measure first (see docs/ARCHITECTURE.md).
-- ═══════════════════════════════════════════════════════════════════════

-- prune completed candles older than the retention window (candles per pair)
create or replace function prune_market_candles(p_days int default 180)
returns int
language plpgsql
security definer
set search_path = public as $$
declare
  deleted int;
begin
  delete from market_candles
  where ts < now() - make_interval(days => greatest(p_days, 7))
    and ts < (select coalesce(min(target_open_ts), 'epoch'::timestamptz) from predictions);  -- never prune data a prediction still references
  get diagnostics deleted = row_count;
  return deleted;
end $$;

-- prune old operational logs (ingestion runs, delivery logs, alerts)
create or replace function prune_operational_logs(p_days int default 90)
returns int
language plpgsql
security definer
set search_path = public as $$
declare
  d1 int; d2 int; d3 int;
begin
  delete from ingestion_runs where started_at < now() - make_interval(days => p_days);
  get diagnostics d1 = row_count;
  delete from telegram_deliveries
    where created_at < now() - make_interval(days => p_days)
      and status in ('sent','skipped');                      -- keep failures longer for audit
  get diagnostics d2 = row_count;
  delete from alert_log where created_at < now() - make_interval(days => p_days);
  get diagnostics d3 = row_count;
  return d1 + d2 + d3;
end $$;

-- keep risk snapshots bounded: one row per scope/window per hour
create or replace function prune_risk_snapshots()
returns int
language plpgsql
security definer
set search_path = public as $$
declare
  deleted int;
begin
  delete from risk_snapshots a
  using risk_snapshots b
  where a.scope = b.scope and a.window = b.window
    and a.created_at < b.created_at
    and date_trunc('hour', a.as_of) = date_trunc('hour', b.as_of)
    and a.id <> b.id;
  get diagnostics deleted = row_count;
  return deleted;
end $$;

-- stale job locks (crashed workers) expire on their own via expires_at,
-- but sweep anything older than a day as belt-and-braces
create or replace function prune_job_locks()
returns int
language sql
security definer
set search_path = public as $$
  with d as (delete from job_locks where expires_at < now() - interval '1 day' returning 1)
  select count(*)::int from d;
$$;
