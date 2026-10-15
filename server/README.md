# NEXUS server worker

Node.js worker that owns everything the public browser must never do:
market-data ingestion, outcome evaluation, risk snapshots, Telegram retries,
operational alerts, retention. Uses the Supabase **service-role key** — keep
it on the server only (the site deploys publicly to GitHub Pages).

## Setup

```bash
cd server
npm install
cp .env.example .env    # fill in SUPABASE_URL + SERVICE_ROLE key (+ Twelve Data keys, Telegram)
```

Apply the SQL migrations first (see `supabase/README.md`) and create the
private `models` Storage bucket.

## Run

```bash
npm start               # continuous loop: evaluation/retries/alerts each poll;
                        #   quota-paced ingestion, risk every 5 min, backfill every 6h, housekeeping daily
npm run once            # one full pass, then exit (cron-friendly)
npm run ingest          # single job entrypoints, for debugging / scheduling:
npm run evaluate        #   each is lock-protected (job_locks table) so running
npm run telegram        #   two instances can never double-process
npm run alerts
npm run backfill        # find + fill gaps from the last 24h
npm run housekeeping    # prune logs/snapshots/candles (+ archive first when ARCHIVE_BEFORE_PRUNE=true)
npm run settings-sync   # write effective non-secret settings to system_settings (dashboard)
npm test                # unit tests (node:test, no network, no Supabase)
```

## Twelve Data credit guard

Apply migration `0007_twelvedata_credit_budget.sql` before running the worker. Every paid, one-symbol data request atomically reserves a credit in Supabase **before** calling Twelve Data. The daily and minute counters survive restarts and are shared by worker instances. If the reservation service is unavailable, the worker fails closed and sends no paid request.

Defaults are **700 worker requests per UTC day** and **6 per minute**. Live ingestion uses at most 80% of the daily cap, leaving the rest for backfills/retries, and rotates through the active pairs at a cadence calculated from the pair count. With the default ten pairs, this is not a real-time feed: expect each pair to refresh roughly every 26 minutes. Raise the cap only to fit the actual Twelve Data plan; the `WORKER_POLL_SECONDS` setting still controls evaluations, Telegram retries and alerts independently. Override with `TWELVEDATA_DAILY_CREDIT_LIMIT`, `TWELVEDATA_PER_MINUTE_LIMIT`, `INGEST_MIN_INTERVAL_SECONDS`, or a smaller `INGEST_PAIRS` list in `server/.env`.

The server counter covers **this worker only**. The browser has its own local credit cap; if both use the same Twelve Data account/key, check DATA → API CREDIT USAGE and leave room for both. Twelve Data's `api_usage` figures are authoritative for the provider account.

### Keep the worker running 24/7

A terminal `npm start` stops when you log out or the machine sleeps. On an always-on Linux VPS, run it under PM2:

```bash
cd /path/to/Nexus/server
npm install
cp .env.example .env       # fill in real values; never commit this file
npm install --global pm2
pm2 start npm --name nexus-worker -- start
pm2 save
pm2 startup                # run the one-time command PM2 prints
pm2 logs nexus-worker
```

Use a VPS/container that does not sleep, and keep `server/.env` on that host. For systemd, set `WorkingDirectory` to `.../Nexus/server`, `ExecStart` to `npm start`, `Restart=always`, and a non-root `User`; the worker loads `server/.env` itself. The static website is separate: GitHub Pages serves the UI continuously, while an open browser tab is still required for browser-only scanning/Telegram engines.

## What each job does

| Job | Cadence | Behaviour |
|---|---|---|
| `ingest` | credit-paced (at most 80% of daily cap) | Fetch 1-min candles for a rotating batch of active pairs from Twelve Data (atomic credit reservation + key rotation/cooldown), keep **completed candles only**, upsert with duplicate/revision detection, compute `nexus-f1` feature snapshots, record an `ingestion_runs` row. Never writes fabricated prices — a provider failure writes nothing but a failed run row. |
| `evaluate` | every poll | Evaluate predictions whose horizon elapsed: entry = open of target candle, exit = close of candle at `target + (horizon−1)·60s`. Direction-adjusted gross bps minus estimated costs (pair spread + slippage). Insert-only (PK = prediction_id) → no duplicate evaluations; corrections go through the audited update path. Missing candles after `EVALUATION_MAX_DELAY_MINUTES` → `invalid`. |
| `telegram` | every poll | Retry deliveries the browser recorded as `failed`/`retrying` (max `TELEGRAM_RETRY_MAX` attempts). Retrying only explicit API failures guarantees no double-sends. |
| `alerts` | every poll | Data lag, missing evaluations, delivery failures, w20 win-rate floor + losing-streak degradation — deduplicated per hour into `alert_log`, mirrored to the ops Telegram chat. |
| `risk` | 5 min | Rolling w20/w100/all snapshots per scope (global / pair / model / strategy): win rate, expectancy, profit factor, max drawdown, streaks. Accuracy is stored separately from **simulated** net returns. |
| `backfill` | 6 h | Detect gaps ≥3 min in the last 24 h per pair and fill them from provider history. |
| `housekeeping` | 24 h | Sweep stale job locks, prune operational logs (90d), risk snapshots (hourly), candles (`RETENTION_DAYS`, default 180). With `ARCHIVE_BEFORE_PRUNE=true`, candles are gzip-archived to the private `models` bucket first — pruning is skipped for any pair whose archive upload fails. |

## Safety properties

- **Job locks** — every job takes `try_job_lock` (atomic upsert, TTL, owner-checked release). Multiple workers can run; only one executes a job at a time. Advisory PG locks don't survive Supabase's pooled REST connection — that's why locking is table-based.
- **Idempotency** — candles upsert on `(pair, tf, ts)`; predictions are unique per `(pair, tf, target, strategy_version, is_shadow)`; outcomes insert-only on PK; risk snapshots dedupe on `(scope, window, as_of)`.
- **No fabrication** — candles are validated (OHLC sanity, minute alignment, completed-only) before storage; rejected rows are counted, never "repaired".
- **Bounded queries** — every pass has explicit limits (200 due predictions, 5000 outcome rows, 500-row upsert chunks, 25 retries).

## External services

| Service | Used for | Env |
|---|---|---|
| Supabase | database + storage | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Twelve Data | 1-min forex candles | `TWELVEDATA_KEYS` (comma-separated, rotated) |
| Telegram Bot API | retries + ops alerts | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPS_CHAT` |

## Tests

`node --test test/` — pure logic only (candle validation, gap detection,
outcome math, risk stats, feature computation, provider health, retention
helpers). No network, no Supabase, no Telegram.
