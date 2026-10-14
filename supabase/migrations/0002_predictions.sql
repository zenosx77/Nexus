-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0002 · predictions & outcomes
-- predictions · trade_outcomes · trade_outcome_revisions (audit trail)
-- ═══════════════════════════════════════════════════════════════════════

-- ── predictions: every signal the engine emits (browser mirror + worker/shadow) ────
create table if not exists predictions (
  id                 uuid primary key default gen_random_uuid(),
  pair_code          text not null references currency_pairs(code) on delete cascade,
  timeframe          text not null default '1m' check (timeframe in ('1m','3m')),
  target_open_ts     timestamptz not null check (target_open_ts = date_trunc('minute', target_open_ts)),
  direction          text not null check (direction in ('CALL','PUT','FLAT')),
  confidence         numeric(5,2) not null check (confidence >= 0 and confidence <= 100),
  grade              text,
  strategy_version   text not null default 'nexus-fusion-v1',
  strategy_detail    jsonb not null default '{}'::jsonb,   -- agent votes, regime, origin, forced flag
  feature_version    text not null default 'browser-live-v1',
  model_version      text,                                  -- FK added after model_versions exists (0003)
  reference_price    numeric(12,7),                         -- entry reference (set by evaluator from candle open)
  evaluation_horizon int not null default 1 check (evaluation_horizon >= 1 and evaluation_horizon <= 60),  -- candles
  source             text not null default 'browser' check (source in ('browser','worker','shadow')),
  is_shadow          boolean not null default false,
  telegram_sent      boolean not null default false,
  created_at         timestamptz not null default now(),
  -- idempotency: one prediction per candle per strategy version per mode
  unique (pair_code, timeframe, target_open_ts, strategy_version, is_shadow)
);
create index if not exists idx_predictions_created on predictions (created_at desc);
create index if not exists idx_predictions_target on predictions (target_open_ts);
create index if not exists idx_predictions_model on predictions (model_version) where model_version is not null;

-- ── trade_outcomes: evaluated results (one canonical row per prediction) ───────────
create table if not exists trade_outcomes (
  prediction_id            uuid primary key references predictions(id) on delete cascade,
  evaluation_horizon       int not null check (evaluation_horizon >= 1),
  exit_ts                  timestamptz not null,          -- target_open_ts + horizon minutes
  -- prices/returns are nullable ONLY for outcome='invalid' rows (candles never arrived);
  -- the audit trigger + is_valid flag keep honest rows honest.
  entry_price              numeric(12,7) check (entry_price is null or entry_price > 0),
  exit_price               numeric(12,7) check (exit_price is null or exit_price > 0),
  direction_adjusted_return numeric(10,7),                -- signed fraction, in prediction direction
  gross_return_bps         numeric(12,3),
  estimated_cost_bps       numeric(12,3) not null default 0 check (estimated_cost_bps >= 0),
  net_return_bps           numeric(12,3),
  outcome                  text not null check (outcome in ('win','loss','breakeven','neutral','invalid')),
  is_valid                 boolean not null default true,
  invalid_reason           text,
  evaluated_at             timestamptz not null default now(),
  evaluated_by             text not null default 'worker',
  constraint outcome_prices_complete
    check (outcome = 'invalid' or (entry_price is not null and exit_price is not null
        and direction_adjusted_return is not null and gross_return_bps is not null
        and net_return_bps is not null))
);
create index if not exists idx_outcomes_evaluated on trade_outcomes (evaluated_at desc);
create index if not exists idx_outcomes_outcome on trade_outcomes (outcome) where is_valid;

-- ── trade_outcome_revisions: audit trail for corrections (append-only) ─────────────
create table if not exists trade_outcome_revisions (
  id             bigserial primary key,
  prediction_id  uuid not null references predictions(id) on delete cascade,
  changed_at     timestamptz not null default now(),
  changed_by     text not null default 'worker',
  previous       jsonb not null,        -- full previous row snapshot
  reason         text
);
create index if not exists idx_outcome_revisions_pred on trade_outcome_revisions (prediction_id, changed_at desc);

-- audit trigger: any UPDATE to a canonical outcome is snapshotted first
create or replace function audit_outcome_revision() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (old.exit_price is distinct from new.exit_price
                        or old.entry_price is distinct from new.entry_price
                        or old.outcome is distinct from new.outcome
                        or old.is_valid is distinct from new.is_valid) then
    insert into trade_outcome_revisions (prediction_id, changed_by, previous, reason)
    values (old.prediction_id, current_setting('app.actor', true), to_jsonb(old), 'outcome corrected');
  end if;
  return new;
end $$;
drop trigger if exists trg_outcome_revision on trade_outcomes;
create trigger trg_outcome_revision before update on trade_outcomes
  for each row execute function audit_outcome_revision();

-- ── convenience view: prediction + outcome joined for dashboards ───────────────────
create or replace view v_prediction_accuracy
with (security_invoker = true) as
select
  p.id, p.pair_code, p.timeframe, p.target_open_ts, p.direction, p.confidence, p.grade,
  p.strategy_version, p.model_version, p.source, p.is_shadow, p.created_at,
  o.outcome, o.is_valid, o.net_return_bps, o.gross_return_bps, o.evaluated_at
from predictions p
left join trade_outcomes o on o.prediction_id = p.id;
