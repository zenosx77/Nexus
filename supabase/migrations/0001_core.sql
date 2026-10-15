-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0001 · core market data
-- currency_pairs · market_candles · market_features (+ seed pairs)
-- All timestamps UTC (timestamptz). Prices numeric(12,7) — covers 5-digit
-- majors and 3-digit JPY pairs with consistent precision.
-- Idempotent by design (create table if not exists / on conflict do nothing).
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- shared trigger: maintain updated_at ------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── currency_pairs: supported pairs + configuration ────────────────────────────────
create table if not exists currency_pairs (
  code          text primary key check (code ~ '^[A-Z]{3}/[A-Z]{3}$'),
  base          text not null,
  quote         text not null,
  is_active     boolean not null default true,
  digits        int     not null default 5 check (digits between 3 and 6),
  pip_size      numeric(12,7) not null default 0.0001 check (pip_size > 0),
  spread_bps    numeric(8,3) not null default 1.0 check (spread_bps >= 0),  -- est. spread, cost model input
  config        jsonb   not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
drop trigger if exists trg_currency_pairs_updated on currency_pairs;
create trigger trg_currency_pairs_updated before update on currency_pairs
  for each row execute function set_updated_at();

-- ── market_candles: completed 1-minute OHLC (live + historical) ─────────────────────
-- Candle identity = (pair, timeframe, open-time). Only COMPLETED candles are stored;
-- the ingestion worker never writes the forming candle (never fabricate prices).
create table if not exists market_candles (
  pair_code   text not null references currency_pairs(code) on delete cascade,
  timeframe   text not null default '1m' check (timeframe = '1m'),
  ts          timestamptz not null check (ts = date_trunc('minute', ts)),  -- candle OPEN time, minute-aligned
  open        numeric(12,7) not null check (open > 0),
  high        numeric(12,7) not null,
  low         numeric(12,7) not null,
  close       numeric(12,7) not null check (close > 0),
  volume      numeric(18,4),
  source      text not null default 'twelvedata',
  revised     boolean not null default false,          -- a later fetch produced different values (audit)
  ingested_at timestamptz not null default now(),
  primary key (pair_code, timeframe, ts),
  constraint candle_ohlc_sane check (
    high >= low and high >= open and high >= close and low <= open and low <= close
  )
);
create index if not exists idx_market_candles_ts on market_candles (ts desc);

-- ── market_features: versioned indicator snapshots (point-in-time model inputs) ────
create table if not exists market_features (
  pair_code      text not null references currency_pairs(code) on delete cascade,
  timeframe      text not null default '1m' check (timeframe = '1m'),
  ts             timestamptz not null check (ts = date_trunc('minute', ts)),
  feature_version text not null,
  features       jsonb not null,                        -- {"e9":…,"rsi":…,…} for THIS candle (computed from history <= ts)
  computed_at    timestamptz not null default now(),
  primary key (pair_code, timeframe, ts, feature_version)
);

-- ── read-only dashboard view: freshness per pair ───────────────────────────────────
create or replace view v_market_freshness
with (security_invoker = true) as
select
  p.code                                            as pair,
  p.is_active,
  c.last_ts,
  extract(epoch from (now() - c.last_ts))::int      as age_seconds,
  c.candle_count
from currency_pairs p
left join (
  select pair_code, max(ts) as last_ts, count(*) as candle_count
  from market_candles group by pair_code
) c on c.pair_code = p.code;

-- ── seed the 10 production pairs (idempotent) ──────────────────────────────────────
insert into currency_pairs (code, base, quote, digits, pip_size, spread_bps) values
  ('EUR/USD','EUR','USD',5,0.0001,0.8),
  ('GBP/USD','GBP','USD',5,0.0001,1.0),
  ('USD/JPY','USD','JPY',3,0.01,   1.0),
  ('AUD/USD','AUD','USD',5,0.0001,1.2),
  ('USD/CAD','USD','CAD',5,0.0001,1.4),
  ('USD/CHF','USD','CHF',5,0.0001,1.4),
  ('EUR/JPY','EUR','JPY',3,0.01,   1.4),
  ('GBP/JPY','GBP','JPY',3,0.01,   1.8),
  ('NZD/USD','NZD','USD',5,0.0001,1.6),
  ('EUR/GBP','EUR','GBP',5,0.0001,1.2)
on conflict (code) do nothing;
