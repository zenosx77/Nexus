# NEXUS × Supabase — end-to-end setup

This wires the optional cloud layer onto the existing site **without changing any
working logic**: the browser stays the live prediction source and only *mirrors*;
all heavy/secret work happens server-side. Nothing here is required — with no
config the site runs exactly as before.

Architecture and design decisions: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

---

## 0. What you need

| Thing | Used for | Where it lives |
|---|---|---|
| Supabase project (free tier works) | database + storage | supabase.com |
| Twelve Data API key(s) | 1-minute candles for the worker | server only |
| Telegram bot token + ops chat | retries + ops alerts | server only |
| Node 18+ | the worker | your server / machine |
| Python 3.9+ | the trainer (stdlib only) | your server / machine |

> **Key rule (enforced everywhere):** the **service-role key**, market-data keys and
> the bot token exist only in `server/.env` / `trainer/.env` (gitignored). The browser
> only ever sees the **anon public key**, which row-level security limits to
> insert-only writes plus monitoring reads. The deploy guard refuses to publish if
> service-role material ever appears in the site.

## 1. Database — apply the migrations

Dashboard → SQL Editor → run each file in order (or `supabase db execute --file`):

```
supabase/migrations/0001_core.sql        pairs, candles, features, 10 seed pairs
supabase/migrations/0002_predictions.sql predictions, outcomes, audit trigger
supabase/migrations/0003_ml.sql          model registry, training runs
supabase/migrations/0004_ops.sql         risk, ingestion, deliveries, settings, job locks
supabase/migrations/0005_rls.sql         row-level security (anon = insert-only mirror)
supabase/migrations/0006_retention.sql   prune functions
supabase/migrations/0007_twelvedata_credit_budget.sql
                                         persistent atomic worker credit guard
```

Then create the **private** Storage bucket: Dashboard → Storage → `models` (private).

Verify (SQL editor):

```sql
select count(*) from currency_pairs;          -- 10
select try_job_lock('setup-check','manual',60); -- true
select release_job_lock('setup-check','manual');
```

## 2. Server worker

```bash
cd server
npm install
cp .env.example .env        # fill in SUPABASE_URL, SERVICE-ROLE key, Twelve Data keys, Telegram
npm run once               # one full pass: ingest → evaluate → telegram → alerts → risk → housekeeping
npm start                  # continuous loop (keep alive with PM2/systemd on an always-on host)
```

For a restart-on-crash/background process on an always-on Linux VPS:

```bash
cd /path/to/Nexus/server
npm install
cp .env.example .env       # fill in the credentials on the server only
npm install --global pm2
pm2 start npm --name nexus-worker -- start
pm2 save
pm2 startup                # run PM2's one-time startup command
pm2 logs nexus-worker
```

**Credit controls:** migration `0007_twelvedata_credit_budget.sql` adds an atomic Supabase-backed guard. The worker defaults to 700 paid requests per UTC day and 6 per minute; it persists reservations across restarts, fails closed if it cannot reserve, and spaces live ingestion to use at most 80% of the daily cap (20% stays available for retries/backfill). Change `TWELVEDATA_DAILY_CREDIT_LIMIT`, `TWELVEDATA_PER_MINUTE_LIMIT`, `INGEST_MIN_INTERVAL_SECONDS`, and `INGEST_PAIRS` in `server/.env` to match the provider plan. With 10 active pairs, the safe default is a slow rotating feed (roughly 26 minutes per pair), not a 1-minute real-time stream. The browser's DATA page has a separate local cap; both budgets are independent, so use the free per-key `api_usage` check to monitor combined account spend.

The worker:
- ingests **completed** 1-minute candles in a credit-paced rotating batch of active pairs
  (rotates Twelve Data keys, reserves each request against the persistent worker budget,
  records every run, detects gaps/duplicates/revisions/staleness, never fabricates prices);
- evaluates predictions after their horizon: entry = open of the target candle,
  exit = close of the last candle in the horizon, direction-adjusted, minus estimated
  costs (pair spread + slippage); missing candles after the max delay → `invalid`;
- snapshots rolling risk stats (win rate / expectancy / profit factor / drawdown /
  streaks per scope and window);
- retries Telegram deliveries **the browser recorded as failed** (explicit API failures
  only → a message can never double-send);
- raises deduplicated ops alerts (data lag, missing evaluations, delivery failures,
  win-rate degradation, losing streaks) to `TELEGRAM_OPS_CHAT`;
- prunes old data (retention) with optional gzip archival to the `models` bucket first.

Tests: `cd server && npm test` (pure logic, no network).

## 3. Trainer (self-learning)

```bash
cd trainer
cp .env.example .env        # SUPABASE_URL + SERVICE-ROLE key (server only)
python3 train.py status     # registry + recent runs
python3 train.py run        # full pipeline (schedule daily, e.g. 03:00)
python3 train.py rollback   # restore the previous production model
python3 -m unittest         # tests (no network)
```

What one `run` does:
1. pulls evaluated production predictions (browser source, non-shadow, ascending by time);
2. splits chronologically — expanding-window walk-forward on the train pool, final 20 %
   holdout **never touched** until the end;
3. learns per-timeframe per-strategy weights (`vwr`/`vtrades` — the same shape the brain
   already consumes) and compares them against the deployed model replay and an
   unweighted-majority baseline on identical data;
4. gates promotion: minimum sample size, walk-forward improvement over the deployed
   model, holdout win-rate floor, profit factor and no-worse expectancy; every run
   records dataset window, sha256, row counts, metrics and its decision;
5. registers the artifact in the private `models` bucket + registry with a SHA-256
   checksum. `training.auto_promote` starts **false** → models land in **shadow**;
   flip it to `true` in `system_settings` only after you trust the pipeline;
   promotion retires (never deletes) the previous model — `rollback` restores it.

## 4. Browser (CLOUD page)

1. Open the site → **CLOUD page** → paste project URL + **anon public key**
   (Dashboard → Settings → API → `anon` `public`) → **SAVE & CONNECT**.
   (Optional: put `window.NEXUS_SB_URL` / `window.NEXUS_SB_ANON` in your local `keys.js`.)
2. Keep **record predictions + delivery results** on. From now on every emitted signal
   is mirrored (insert-only) together with its per-strategy votes, and every completed
   Telegram send/failure is recorded.
3. **CLOUD MODEL → APPLY CLOUD MODEL TO BRAIN** — appears once a model is deployed.
   The page re-computes the artifact's SHA-256 with `crypto.subtle` and refuses on any
   mismatch; on success it merges the weights into the brain (`deep[tf].strats[s].vwr/vtrades`).
   It is never silent and never changes prediction logic — re-run
   **TRAIN THE DATA AT MAX** to return to local weights.
4. The other panels show simulated performance (clearly labelled), worker feed health
   and the delivery log. Everything degrades gracefully: no config = no cloud calls.

## 5. Deployment / operations checklist

- [ ] migrations 0001–0007 applied in order; `models` bucket private
- [ ] RLS verified: anon can INSERT `predictions` / `telegram_deliveries` but never
      UPDATE/DELETE anything (0005 policies)
- [ ] `server/.env` + `trainer/.env` created, never committed (gitignored)
- [ ] worker running under PM2/systemd on an always-on host — watch `ingestion_runs` and supervisor logs
- [ ] trainer scheduled (`train.py run`), `training.auto_promote` still `false`
- [ ] ops alerts arriving in `TELEGRAM_OPS_CHAT`
- [ ] CLOUD page connected with the anon key; signals appear in `predictions`
- [ ] GitHub Pages deploys still pass the credential guard
      (`tools/check-public.cjs` — also refuses service-role keys now)

## 6. Backup / recovery

- **Database:** Supabase → Database → Backups (daily on paid plans; on free plans run
  `supabase db dump` on a schedule). Critical tables: `predictions`, `trade_outcomes`,
  `trade_outcome_revisions`, `model_versions`, `training_runs`.
- **Model artifacts:** every artifact is mirrored as `artifact_payload` inside
  `model_versions` (checksum-verified) in addition to the Storage object — the registry
  alone is enough to restore the deployed weights.
- **Browser state:** deep weights live in localStorage (`nx_deep`); the cloud model can
  be re-applied from the CLOUD page at any time.
- **Rollback a bad model:** `python3 train.py rollback` (previous model is preserved with
  `retired`/`rolled_back` status, never deleted).

## 7. Monitoring (independent of the dashboard)

- `ingestion_runs` — provider health, latency, gaps, errors per pair
- `alert_log` — deduplicated alert history
- `risk_snapshots` — rolling performance per scope
- worker logs — structured `ISO [level] message` lines on stdout (journalctl / pm2 / docker logs)
