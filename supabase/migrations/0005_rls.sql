-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0005 · Row Level Security
-- Principle: the browser (anon key) may INSERT predictions and delivery
-- records, and READ monitoring data. It can never UPDATE or DELETE
-- anything, and can never touch configuration. The server worker uses the
-- service-role key, which bypasses RLS, and is the only writer of
-- outcomes, candles, features, models and settings.
-- ═══════════════════════════════════════════════════════════════════════

alter table currency_pairs      enable row level security;
alter table market_candles      enable row level security;
alter table market_features     enable row level security;
alter table predictions         enable row level security;
alter table trade_outcomes      enable row level security;
alter table trade_outcome_revisions enable row level security;
alter table model_versions      enable row level security;
alter table training_runs       enable row level security;
alter table risk_snapshots      enable row level security;
alter table ingestion_runs      enable row level security;
alter table telegram_deliveries enable row level security;
alter table system_settings     enable row level security;
alter table alert_log           enable row level security;
alter table job_locks           enable row level security;

-- ── telegram deliveries: anon may INSERT its completed attempt results ─────────────
-- No direct public SELECT: rows contain chat_id and message payloads which must
-- not be readable with the public anon key. The dashboard reads the restricted
-- projection v_deliveries_public instead (owner-privileged view, safe columns).
drop policy if exists deliveries_anon_insert on telegram_deliveries;
create policy deliveries_anon_insert on telegram_deliveries for insert with check (
  status in ('sent','failed','skipped')   -- browser records completed attempts; retries are server-side
  and attempts between 1 and 5
);

create or replace view v_deliveries_public as
select
  id, prediction_id, channel, message_kind, status, attempts,
  telegram_message_id, (last_error is not null) as has_error,
  first_attempt_at, last_attempt_at, sent_at, created_at
from telegram_deliveries;

-- ── public configuration: read-only ────────────────────────────────────────────────
drop policy if exists pairs_public_read on currency_pairs;
create policy pairs_public_read on currency_pairs for select using (true);

-- ── market data: read-only to the public (writes happen with service role only) ────
drop policy if exists candles_public_read on market_candles;
create policy candles_public_read on market_candles for select using (true);

drop policy if exists features_public_read on market_features;
create policy features_public_read on market_features for select using (true);

-- ── predictions: anon may INSERT (browser mirror) and SELECT; never update/delete ──
drop policy if exists predictions_public_read on predictions;
create policy predictions_public_read on predictions for select using (true);

drop policy if exists predictions_anon_insert on predictions;
create policy predictions_anon_insert on predictions for insert with check (
  source = 'browser'          -- the public may only record browser-originated signals
  and is_shadow = false       -- shadow predictions are produced server-side only
);

-- ── outcomes + audit: read-only to the public (evaluator writes via service role) ──
drop policy if exists outcomes_public_read on trade_outcomes;
create policy outcomes_public_read on trade_outcomes for select using (true);

drop policy if exists outcome_revisions_public_read on trade_outcome_revisions;
create policy outcome_revisions_public_read on trade_outcome_revisions for select using (true);

-- ── model registry + training: read-only to the public ────────────────────────────
drop policy if exists models_public_read on model_versions;
create policy models_public_read on model_versions for select using (true);

drop policy if exists training_public_read on training_runs;
create policy training_public_read on training_runs for select using (true);

-- ── monitoring: read-only to the public ────────────────────────────────────────────
drop policy if exists risk_public_read on risk_snapshots;
create policy risk_public_read on risk_snapshots for select using (true);

drop policy if exists ingestion_public_read on ingestion_runs;
create policy ingestion_public_read on ingestion_runs for select using (true);

drop policy if exists alerts_public_read on alert_log;
create policy alerts_public_read on alert_log for select using (true);

drop policy if exists settings_public_read on system_settings;
create policy settings_public_read on system_settings for select using (true);

-- job locks are internal: no public policy at all (service role only)

-- ── telegram deliveries ─────────────────────────────────────────────────────────────
-- (see the deliveries_anon_insert policy + v_deliveries_public view above —
--  the base table is NOT publicly readable: it holds chat ids and payloads)
