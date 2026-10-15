# NEXUS × Supabase — end-to-end setup

> **Supabase Edge hosting:** see the [Edge relay runbook](docs/SUPABASE_EDGE_RELAY.md) for the prepared GitHub Pages + Supabase option, shared 0009 quota prerequisites, secrets, verification and rollback. Not deployed.

This wires shared Supabase storage and the authenticated server relay to the
existing site while preserving its strategies, weights, UI, browser/worker credit
limits, and signal engines. The browser remains the live prediction source and
mirrors its records into the existing **shared/anonymous** schema; this does not
make predictions or delivery rows user-owned. Market-data and Telegram secrets
are server-only. Without the relay, local strategy/paper state remains available,
but server-backed market data and Telegram transport are unavailable.

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

> **Key rule:** the **service-role key**, Twelve Data keys, Telegram bot token, and
> private chat destinations exist only in host environment files such as `server/.env`
> and `trainer/.env` (gitignored). The browser uses only the public Supabase anon key
> for the intentional shared mirror and the authenticated relay session; it never
> calls Twelve Data or Telegram directly. The Pages build guard blocks credential-bearing
> artifacts.

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
supabase/migrations/0008_cloud_security_and_browser_budget.sql
supabase/migrations/0009_shared_account_quota.sql
                                         browser relay budget + grants/SECURITY DEFINER hardening
```

Review and apply the migrations in order in the target project; no migration is applied
by this repository automatically. Then create the **private** Storage bucket: Dashboard
→ Storage → `models` (private). Enable anonymous sign-ins in Supabase Auth so the app
can obtain a short-lived bearer session for the relay. This Auth session does not change
the public/shared ownership model.

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
npm run once               # one full worker pass, then exit
npm run api                # separate authenticated relay process, binds 0.0.0.0:NEXUS_API_PORT (default 8787)
npm start                  # continuous worker loop (supervise separately with PM2/systemd)
```

For the relay, set `NEXUS_ALLOWED_ORIGINS` to exact browser origins (scheme + hostname,
no path; never `*`) and terminate TLS at the host proxy. Configure the same API base URL
in the app’s CLOUD page. Telegram sending/polling is restricted to Supabase Auth user
UUIDs listed in `NEXUS_TELEGRAM_ADMIN_USER_IDS`; the app displays its current UUID after
connection so the operator can provision an allowlist entry. Keep provider, bot, and
service-role values in the host’s environment only.

For a restart-on-crash/background process on an always-on Linux VPS:

```bash
cd /path/to/Nexus/server
npm install
cp .env.example .env       # fill in the credentials on the server only
npm install --global pm2
pm2 start npm --name nexus-worker -- start
pm2 start npm --name nexus-api -- run api
pm2 save
pm2 startup                # run PM2's one-time startup command
pm2 logs nexus-worker
```

**Credit controls:** migration `0009_shared_account_quota.sql` adds the mandatory account-wide guard: 700 paid calls/UTC day and six/rolling minute across worker, browser, retries and failover keys. Prior 0007/0008 counters become secondary scope limits, not independent allowances. Initial installation intentionally exhausts its current UTC day and adds a 61-second quarantine. Stop all consumers and obtain explicit approval before applying. Never restore the older RPC definitions or reset budget tables. The server requires a versioned RPC and fails closed when unavailable. Review [the cutover procedure](docs/DEPLOYMENT_VERIFICATION.md), run both read-only 0008/0009 verifiers, verify the private `models` bucket, and inventory all account consumers before production activation. No hosted application of this migration has been verified.

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

Tests: `cd server && npm test` (logic and loopback HTTP; fake database/provider/Bot transports, no hosted access). Root `npm test` additionally exercises migrations 0001–0009 in disposable PGlite. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) before any live staging steps; migration files do not prove hosted state.

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

1. Open the site → **CLOUD page** → enter the HTTPS NEXUS API relay base URL, Supabase
   project URL, and **anon public key** (Dashboard → Settings → API → anon public) →
   **SAVE & CONNECT**. Do not put provider, bot, or service-role credentials in the page.
2. Enable anonymous sign-ins in Supabase Auth. The page creates/restores an Auth session
   for authenticated relay requests. To enable Telegram controls, add the displayed
   Supabase Auth user UUID to `NEXUS_TELEGRAM_ADMIN_USER_IDS` on the server and configure
   the bot/destinations there. Channel aliases are returned to the browser; private chat
   IDs and tokens are not.
3. Keep **record predictions** on if you want the existing shared prediction mirror.
   Delivery audit rows and retryable payloads are recorded by the authenticated server
   relay when this option is enabled; anonymous roles cannot create retryable deliveries.
   Signals and delivery records remain shared/anonymous, not per-user-owned.
4. **CLOUD MODEL → APPLY CLOUD MODEL TO BRAIN** appears once a model is deployed. The
   page recomputes the artifact SHA-256 and refuses on mismatch; success merges weights
   into the existing brain without changing strategy logic. Re-run **TRAIN THE DATA AT MAX**
   to return to local weights.
5. The other panels show simulated performance, safe market-feed freshness, and a
   restricted delivery status log. Without Supabase migrations or a configured server,
   relay-backed market data and Telegram cannot operate; local strategy/paper state remains.

## 5. Deployment / operations checklist

- [ ] migrations 0001–0009 reviewed and applied in order; `models` bucket private
- [ ] Verify anon/authenticated access is read/insert-only where intended; admin tables,
      delivery base rows, budgets, and maintenance SECURITY DEFINER functions are private
- [ ] Anonymous Auth sign-in enabled; API relay CORS uses exact production browser origins
- [ ] `server/.env` + `trainer/.env` created on hosts, never committed (gitignored)
- [ ] API relay and worker run as separate supervised services; inspect logs and health routes
- [ ] Telegram admin UUID allowlist and server-side bot destinations verified
- [ ] trainer scheduled (`train.py run`) only when explicitly approved; auto-promote remains false
- [ ] CLOUD page connected with public anon key; verify shared prediction mirror is unchanged
- [ ] GitHub Pages deploy passes `tools/check-public.cjs` with no credentials in public output

**This repository checkout has not verified a live Supabase migration ledger, Auth settings,
Storage bucket, staging rows, or the production origin/proxy. Do not treat the checklist as
completed until each item is checked against a safe staging project.**

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
