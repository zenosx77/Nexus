-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0004 · operations layer
-- risk_snapshots · ingestion_runs · telegram_deliveries · system_settings
-- job_locks · alert_log
-- ═══════════════════════════════════════════════════════════════════════

-- ── risk_snapshots: rolling performance per scope ──────────────────────────────────
create table if not exists risk_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  scope               text not null,                     -- 'global' | 'pair:EUR/USD' | 'model:<id>' | 'strategy:<v>'
  "window"            text not null check ("window" in ('w20','w100','all')),
  as_of               timestamptz not null,
  sample_size         int not null default 0,
  wins                int not null default 0,
  losses              int not null default 0,
  breakeven           int not null default 0,
  neutral             int not null default 0,
  win_rate            numeric(6,4),                      -- decisive-only
  expectancy_bps      numeric(12,3),
  profit_factor       numeric(10,4),
  net_return_bps      numeric(14,3),
  max_drawdown_bps    numeric(14,3),
  current_losing_streak int not null default 0,
  max_losing_streak   int not null default 0,
  created_at          timestamptz not null default now(),
  unique (scope, "window", as_of)
);
create index if not exists idx_risk_latest on risk_snapshots (scope, created_at desc);

-- ── ingestion_runs: provider health, gaps, errors, latency ─────────────────────────
create table if not exists ingestion_runs (
  id               uuid primary key default gen_random_uuid(),
  pair_code        text references currency_pairs(code) on delete cascade,
  kind             text not null default 'live' check (kind in ('live','backfill','gapfill')),
  status           text not null default 'running' check (status in ('running','succeeded','failed','partial')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  candles_fetched  int not null default 0,
  candles_upserted int not null default 0,
  duplicates       int not null default 0,
  revised          int not null default 0,
  gaps_detected    int not null default 0,
  gap_details      jsonb,
  latency_ms       int,
  error            text
);
create index if not exists idx_ingestion_recent on ingestion_runs (started_at desc);
create index if not exists idx_ingestion_pair on ingestion_runs (pair_code, started_at desc) where pair_code is not null;

-- ── telegram_deliveries: attempts, status, message ids, retry history ──────────────
create table if not exists telegram_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  prediction_id       uuid references predictions(id) on delete set null,
  channel             text not null check (channel in ('main','public','vip','list','ops')),
  chat_id             text not null,
  message_kind        text not null default 'signal'
                        check (message_kind in ('signal','verdict','list','result','alert','sticker','other')),
  status              text not null default 'pending'
                        check (status in ('pending','sent','failed','retrying','skipped')),
  attempts            int not null default 0 check (attempts >= 0),
  telegram_message_id text,
  last_error          text,
  payload             text check (length(coalesce(payload,'')) <= 4096),
  first_attempt_at    timestamptz not null default now(),
  last_attempt_at     timestamptz,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists idx_deliveries_recent on telegram_deliveries (created_at desc);
create index if not exists idx_deliveries_retry on telegram_deliveries (last_attempt_at)
  where status in ('pending','retrying','failed');
create index if not exists idx_deliveries_prediction on telegram_deliveries (prediction_id) where prediction_id is not null;

-- ── system_settings: worker/trainer configuration (service-write, anon-read) ───────
create table if not exists system_settings (
  key        text primary key check (key ~ '^[a-z0-9_.]+$'),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'worker'
);
drop trigger if exists trg_settings_updated on system_settings;
create trigger trg_settings_updated before update on system_settings
  for each row execute function set_updated_at();

insert into system_settings (key, value) values
  ('evaluation.horizon_candles',   '1'),
  ('evaluation.grace_seconds',     '120'),
  ('evaluation.max_delay_minutes', '30'),
  ('telegram.retry_max',           '3'),
  ('alerts.winrate_floor_w20',     '0.40'),
  ('alerts.losing_streak',         '5'),
  ('alerts.data_lag_seconds',      '180'),
  ('alerts.pending_eval_minutes',  '15'),
  ('alerts.failed_deliveries',     '5'),
  ('retention.candles_days',       '180'),
  ('training.schedule_cron',       '"0 3 * * *"'),
  ('training.auto_promote',        'false'),
  ('training.min_train_rows',      '300'),
  ('training.min_wf_winrate_delta','0.02'),
  ('training.min_holdout_winrate', '0.50')
on conflict (key) do nothing;

-- ── job_locks: DB-level mutual exclusion for background jobs (idempotent workers) ──
create table if not exists job_locks (
  name       text primary key,
  owner      text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- atomic try-lock: succeeds only when free or expired. Returns true when acquired.
create or replace function try_job_lock(p_name text, p_owner text, p_ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public as $$
declare
  got boolean;
begin
  insert into job_locks (name, owner, expires_at)
  values (p_name, p_owner, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set owner = excluded.owner, expires_at = excluded.expires_at
    where job_locks.expires_at < now()
  returning true into got;
  return coalesce(got, false);
end $$;

create or replace function release_job_lock(p_name text, p_owner text)
returns void
language sql
security definer
set search_path = public as $$
  delete from job_locks where name = p_name and owner = p_owner;
$$;

-- ── alert_log: operational alerts with dedupe (never spam the ops chat) ────────────
create table if not exists alert_log (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  severity    text not null default 'warn' check (severity in ('info','warn','critical')),
  dedupe_key  text not null,
  message     text not null,
  payload     jsonb,
  delivered   boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists idx_alert_dedupe on alert_log (dedupe_key, created_at);
create index if not exists idx_alert_recent on alert_log (created_at desc);
