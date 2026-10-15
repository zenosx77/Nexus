# Backend deployment preparation — staging first

**Status (2026-10-15):** the confirmed deployment is GitHub Pages only. No backend host is configured or verified; hosted Supabase migration 0008 is **unconfirmed**. This document is a preparation/runbook, not authorization to deploy. Repository tests use mocks and disposable in-memory PostgreSQL only. No production settings, migrations or credentials have been changed.

## 1. Hosting recommendation and process separation

The simplest managed fit is **one Node web service plus one background-worker service on Render** (or an equivalent host offering both long-lived process types). This recommendation follows the actual Node process model, not a verified provider account, price or deployment. Confirm current Node/runtime, worker availability, region, sleep/restart behavior, port routing and billing before selecting a plan. Do not use a sleeping/free web instance to impersonate an always-on worker.

| Setting | Authenticated relay | Continuous worker |
|---|---|---|
| Repository subdirectory | `server` | `server` |
| Runtime | Node 22 or newer, matching the tested lockfile | Same |
| Build/install | `npm ci --ignore-scripts` | Same |
| Start command | `npm run api` | `npm start` |
| Process model | HTTP server bound to `0.0.0.0` | Long-running scheduled loop; no HTTP listener |
| Port | Configure host routing to **`NEXUS_API_PORT`**, default 8787 | None |
| Health | `GET /api/v1/health` for **liveness only** | Logs and database job/activity timestamps |
| Instances initially | One | One |
| TLS | Managed proxy terminates HTTPS; private upstream HTTP | Outbound HTTPS only |
| Restart | Supervised; use a pinned release revision | Supervised, only after bounded staging validation |

**Port gotcha:** the app does not read `PORT`. Use the host's custom routing setting or set the existing `NEXUS_API_PORT` to the numeric port the host routes. Do not introduce an unsupported environment name, bake secrets into a start command, or assume platform defaults will work. If the platform requires code changes for routing, review those separately. No provider manifest or automatic backend deployment is enabled by this work.

Both services can use the same repository and lockfile, but they must have **separate service definitions and environment scopes**. Do not start both with shell backgrounding in a web service. A small VM with a TLS reverse proxy and two supervised processes is a compatible alternative, but adds patching/proxy/monitoring responsibility. GitHub Pages runs neither process. Short-lived serverless functions can host a redesigned relay, but do not fit the existing worker loop. Scheduled Actions/cron are not equivalent to this continuous worker.

## 2. Environment and secret boundaries

Use `server/.env.example` as the exact code-derived inventory. It contains only secret placeholders and non-secret defaults. **Do not run it unchanged:** non-empty placeholders may appear “configured” in health even though they are unusable. On a managed host, use its private environment/secret interface; local `server/.env` is optional and ignored by Git. Host variables override `.env` values. Never put secrets in Pages configuration, build output, `keys.js`, localStorage, sessionStorage, logs, command history, screenshots or chat.

| Actual names | Required/behavior |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Both processes need the **staging** project and its private server credential. The key variable may hold the project's appropriate service-role/secret key; never a public anon key. |
| `TWELVEDATA_KEYS` | Comma-separated private provider keys; needed for paid relay/ingestion. Prefer one isolated staging key for a bounded test. |
| `NEXUS_API_PORT`, `NEXUS_ALLOWED_ORIGINS` | Relay routing and exact allowed browser origins. No `*`, credentials, paths, queries, fragments or trailing slashes. A Pages project at `/Nexus/` still has origin `https://<account>.github.io`. |
| `NEXUS_API_USER_RATE_LIMIT_PER_MINUTE`, `NEXUS_TELEGRAM_RATE_LIMIT_PER_MINUTE` | Additional process-local limits; defaults 60 and 30. Usage has a fixed 10/user/minute limit. |
| `TWELVEDATA_BROWSER_DAILY_CREDIT_LIMIT=700`, `TWELVEDATA_BROWSER_PER_MINUTE_LIMIT=7` | Persistent browser pool. Do not raise during deployment preparation. |
| `TWELVEDATA_DAILY_CREDIT_LIMIT=700`, `TWELVEDATA_PER_MINUTE_LIMIT=6` | Persistent worker pool. Do not raise during deployment preparation. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MAIN_CHAT`, `TELEGRAM_PUBLIC_CHAT`, `TELEGRAM_VIP_CHAT`, `TELEGRAM_LIST_CHAT`, `TELEGRAM_ADMIN_CHAT`, `TELEGRAM_OPS_CHAT` | Optional for initial staging tests. Use a separate test bot and private test destinations only in later authorized delivery tests. Omit/unset all of these initially, rather than entering placeholders. |
| `NEXUS_TELEGRAM_ADMIN_USER_IDS` | Explicit Supabase Auth user UUID allowlist for relay Telegram controls. Keep empty initially. It is not a chat ID or bot token. |
| `NEXUS_CLOUD_SYNC_ENABLED`, `NEXUS_CLOUD_MODEL_ENABLED` | Non-secret relay/UI behavior flags. Sync flag also gates optional relay delivery logging; not a worker dry-run switch. |
| `WORKER_POLL_SECONDS`, `INGEST_MIN_INTERVAL_SECONDS`, `INGEST_PAIRS`, `INGEST_OUTPUTSIZE` | Worker polling/cadence and bounded ingestion choices. Defaults: 30s, 60s minimum, active DB pairs, 360 candles. Credit pacing—not polling frequency—limits live ingestion. |
| `EVALUATION_HORIZON_CANDLES`, `EVALUATION_GRACE_SECONDS`, `EVALUATION_MAX_DELAY_MINUTES` | Evaluation defaults: 1, 120s, 30min. |
| `TELEGRAM_RETRY_MAX`, `ALERT_WINRATE_FLOOR_W20`, `ALERT_LOSING_STREAK`, `ALERT_DATA_LAG_SECONDS`, `ALERT_PENDING_EVAL_MINUTES`, `ALERT_FAILED_DELIVERIES` | Worker retry and alert behavior; not safety/off switches. |
| `RETENTION_DAYS`, `ARCHIVE_BEFORE_PRUNE`, `LOG_LEVEL` | Retention defaults 180 days, archival false, logging info. `ARCHIVE_BEFORE_PRUNE=false` **does not disable pruning**. |

Missing public/vip/list/admin Telegram destinations **fall back to MAIN**. Set every desired alias explicitly before using real delivery; do not assume a missing destination means disabled. `TELEGRAM_OPS_CHAT` is separate and used for worker alerts, not a relay channel alias. The relay's aliases are main/public/vip/list/admin.

Browser configuration contains only the public relay base URL, Supabase project URL and public anon key. Auth access/refresh tokens are user-session credentials held in sessionStorage, not provider/server secrets; treat them as sensitive and do not copy them to logs. The built-in browser flow uses anonymous Supabase Auth. An allowlisted anonymous UUID identifies that session, not a permanent operator account; clearing/losing the session can require deliberate reauthorization. Never allowlist every anonymous user or ship an admin bearer token.

## 3. Limits and security expectations

- Browser limits remain **700/UTC day and 7/fixed minute**. Routine scan/ticker calls stop at 560/day, leaving settlement headroom. Clients can choose categories; this is allocation, not proof a request is a genuine settlement.
- Worker limits remain **700/UTC day and 6/fixed minute**. Live ingestion targets 80% of the daily pool, reserving remaining room for backfill/retries. With ten pairs this is a slow rotating feed, not a real-time one-minute feed.
- Every paid provider attempt, including retry/failover attempts, must reserve first. Database/RPC failures block paid requests. Counters survive process restarts; **never reset budget tables to bypass a limit**.
- The two independent pools can together allow 1400/day and 13/minute. They do not reconcile an external machine or a shared provider account. Verify account-level plan/combined usage before enabling both; separate keys do not necessarily mean separate account quotas.
- CORS requires exact origins on non-health routes; missing/hostile origins fail. OPTIONS is unauthenticated but restricted to allowed origins/methods/headers. All data/control routes validate a bearer through Supabase Auth. Telegram requires the user UUID allowlist as well.
- CORS is not access control for arbitrary HTTP clients; anonymous Auth is obtainable. Apply upstream connection/request/body-size/timeout controls and monitor abuse. In-process per-user throttles reset on restart and do not coordinate replicas. Keep one relay instance initially.
- Relay market requests use operation/parameter/single-symbol allowlists, JSON-only object bodies and a 32 KiB body limit. Paid budgets are authoritative; the browser's local limits are secondary.
- Health reports configured provider/key count, local cooldown status and channel booleans. It does **not** verify Supabase, migration 0008, Auth, provider connectivity or worker operation. Do not label it readiness.

### Delivery integrity and remaining limitations

0008 denies anon/authenticated access to raw delivery tables and delivery inserts. Historical rows default to `server_managed=false`; retries select only server-managed rows and configured destinations. Relay records use aliases, sanitized text/errors and server-generated status/attempt/message timestamps. Public operational views omit raw destinations, payloads and errors. Prediction records remain an intentional shared insert/read mirror—not user-owned, trusted performance evidence.

Relay message logging is **opt-in** (`record_delivery` plus cloud sync); it is not a guaranteed audit of all sends. Logged responses now include `deliveryLog.recorded`. A successful send with `recorded:false` still returns success, displays a browser warning and must **not be blindly resent**. Worker persistence errors stop the retry pass rather than falsely declaring success. Sticker sends are not persisted for retry. Existing retry payloads do not retain parse mode/protection metadata; retries use worker defaults (HTML/protection), so test HTML-only messages in the initial retry check.

There is no transactional outbox or Telegram idempotency guarantee. A timeout after Telegram accepts a send, a process crash, failed status persistence or a job exceeding its lock TTL can produce duplicates. Database locks reduce overlap but do not make delivery exactly once. Keep the worker stopped while diagnosing uncertain deliveries; inspect Telegram message IDs and rows before resuming. Guaranteed audit/exactly-once delivery would require a separately reviewed design.

## 4. Local verification (no hosted access)

Requirements: Node 22+, npm and Python 3. Dependencies are lockfile-pinned.

```bash
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm test
```

`npm test` runs browser smoke/regressions, offline server HTTP/logic tests, Python trainer tests, disposable PGlite migrations/role checks, scanner negative fixtures, environment contract tests, then assembles/scans `.cache/public`. The artifact contains exactly the same three files copied by the current Pages workflow: HTML, font and font license. The font binary is not a text scan target. Nothing is uploaded/deployed. The existing Pages workflow and production settings are unchanged.

The migration harness executes 0001–0008 with pgcrypto and simulated anon/authenticated/service roles, tests 0008 reapplication, privilege revocations, safe views, RLS, delivery provenance, UTC rollover and quota boundaries. It discovered/fixed SQL quoting for the existing `window` column in 0004/0006; no column was renamed. **Do not rewrite a hosted migration ledger or rerun historical migrations merely because the repository quoting changed.**

PGlite serializes one connection, so it does not prove multi-connection lock behavior, Supabase default grants, PostgREST role switching, Auth configuration, Storage, host TLS or CORS proxy behavior. The scanner detects recognized formats/assignments; it is not proof that every possible private string is absent. Keep the artifact explicit-file allowlist and review it manually.

## 5. Staging-first checklist (future authorized operator work)

Do not execute live steps as part of repository preparation. Obtain explicit **staging** deployment/migration/test approval first. Production requires a separate go/no-go decision.

### A. Isolate and verify database state

- [ ] Record project identifier, environment, release revision and recovery owner. Confirm the target is a disposable/staging Supabase project, **not production**, before entering any credentials.
- [ ] Use isolated staging data, Auth and bot destinations; do not restore production payloads/credentials into staging. Save a staging backup/schema snapshot before changes.
- [ ] Inspect the actual migration ledger if maintained. Existing SQL Editor applications may not have a ledger entry; verify resulting schema/grants regardless. Record evidence, not “file exists”.
- [ ] On a fresh authorized staging project, apply migrations **0001–0008 in order**, using a reviewed SQL Editor/CLI procedure. On an existing staging project, review prerequisites and apply only missing changes. Do not use an unreviewed loop over historic migrations. Migrations are not applied automatically by npm/startup.
- [ ] Run `supabase/verify/0008_read_only.sql` as the staging database administrator. It checks schema, RLS, raw-table revocations, safe views, service-role access, no public-schema CREATE and protected RPC privileges without spending provider credit or mutating rows.
- [ ] Verify via actual PostgREST anon/authenticated sessions that delivery forgery and operational writes/RPCs are denied, prediction inserts obey RLS, and safe views work. Record status codes without recording tokens.
- [ ] Verify RPC concurrency/700-day boundaries using synthetic counters in an **isolated transaction/test database with rollback**, not live provider requests and never production budget tables. Check actual multi-connection contention separately; PGlite cannot demonstrate it.
- [ ] Create private `models` Storage only if archive/trainer workflows will be used. Verify it is not publicly readable; neither initial relay nor bounded ingestion requires it.
- [ ] Enable/review anonymous Auth in staging, its abuse controls and project URL/redirect settings. Do not change production Auth.

### B. Relay only, worker remains disabled

- [ ] Select an always-available web service, Node 22+, pin the approved revision, disable automatic production deployment, install with the server lockfile. Configure the port/TLS explicitly.
- [ ] Enter only staging private environment values; leave Telegram and its admin allowlist unset for the initial check. Set the staging browser's exact origin, not an origin containing a path or wildcard.
- [ ] Start **only** `npm run api` after staging approval. Check public `GET /api/v1/health`: expect 200, `ok:true`, browser limits 700/7, no secrets. Repeat after a restart; this is liveness, not migration readiness.
- [ ] From the staging browser origin, check preflight: POST/Authorization/Content-Type allowed, exact ACAO and Vary: Origin, no wildcard. Disallowed origin/null/origin-with-path should be 403. Health with no Origin may be 200; protected no-Origin routes must be 403.
- [ ] Missing/expired/invalid bearer → 401; Auth dependency outage → 503, without provider calls. Valid session → `/api/v1/session` 200. Non-admin Telegram → 403. Keep bearer tokens in the browser/session, not a pasted command or screenshot.
- [ ] Malformed JSON, null/array bodies, unknown provider operations/parameters, comma-separated symbols and invalid outputsize → 400. Wrong content type → 415, over 32 KiB → 413. No provider call should result.
- [ ] Test per-user 429/reset behavior using mocked dependencies or low temporary **additional** staging API throttle settings; do not raise paid credit caps or consume hundreds of provider calls. Keep the documented 700/7 and 700/6 paid limits unchanged.
- [ ] With an isolated staging key, authorize **one** market `price` request and observe a browser-pool reservation before a provider response. Free `/api/v1/usage` should show key aliases only. Stop if account quota/response is unexpected.
- [ ] Verify dependency/RPC failure blocks paid calls (offline tests cover this; any live fault injection must be isolated staging). Never drop a production function to test fail-closed behavior.
- [ ] Inspect logs, network responses and the actual publishable artifact for provider/Bot/service keys and private destinations. Re-run `npm run check:public` before any future static release.

### C. Safe worker test — bounded, not the loop

- [ ] First run `npm --prefix server test`: the offline retry/credit tests exercise a bounded worker path with fake transports and no live database or Telegram sends.
- [ ] For a future explicitly authorized live staging test, leave the continuous worker service **disabled**, omit all Telegram credentials/destinations, use a fresh staging DB and one isolated provider key.
- [ ] Set existing staging worker controls `INGEST_PAIRS=EUR/USD` and `INGEST_OUTPUTSIZE=60`; retain worker limits **700/day, 6/minute**. Confirm the pair is active and no competing worker exists.
- [ ] Run **`npm run ingest` once** from `server/`, with a supervisor/operator timeout (for example 60 seconds). This is a bounded, side-effecting ingestion job, **not dry-run**: it can spend one provider credit with one key and write candles/features/ingestion records. If terminated mid-request, inspect counters/rows before another attempt.
- [ ] Verify an ingestion run, valid completed candles, features, released/expired job lock, and at most the expected credit increment. No backfill, alerts, Telegram, settings sync or pruning should have run. Inspect row status/error details; exit status alone is not evidence of successful data ingestion.
- [ ] Stop here and review results. Do **not** run `once` as a smoke test: it includes Telegram retries/alerts, backfill, settings writes and retention. Do **not** run `npm start` during preparation.
- [ ] Only if delivery testing is separately approved: configure a dedicated staging bot/test chat and one admin UUID; send one clearly labeled HTML test message. Verify alias-only response, `deliveryLog.recorded:true`, server-managed row/status/message ID and safe public view. Exercise retry states with mocked transport first; do not deliberately send failures to production chats.
- [ ] Continuous-worker authorization requires reviewing retention/retry queues, combined provider quotas, job lock TTLs, polling overlap, restart/delivery risks, monitoring and alert destinations first.

## 6. Monitoring and rollback

**Relay:** monitor liveness, Auth 401/503 rates, validation failures, 429/Retry-After, provider cooldowns, guard-unavailable errors, and delivery audit warnings. Validate Auth/migration readiness separately after every environment/release change. Do not pay for provider requests on every health poll.

**Worker:** once separately authorized, monitor process restarts and error logs; `ingestion_runs`, `market_candles` freshness, `job_locks`, pending evaluations and service-managed delivery attempts. The public `v_ingestion_health_public` omits raw errors; use privileged diagnostics privately. A green relay health response cannot demonstrate a live worker. Allow for credit-paced ingestion before setting freshness alert expectations.

**Rollback order:**

1. Disable/stop the worker first, then disable affected relay traffic or stop the relay. Do not leave old/new worker instances running together.
2. Save sanitized diagnostics and delivery/message IDs. Treat uncertain sends as possibly delivered; do not replay queues blindly.
3. Restore the previous **approved relay-compatible** application revision and lockfile. Keep production browser configuration untouched during staging work. If a future browser cutover occurred, revert to its prior approved configuration or disable the relay-dependent features—not direct provider calls.
4. **Retain 0008 security restrictions and budget counters.** Do not restore anonymous delivery inserts, expose raw tables, reopen maintenance RPCs or reset budgets to make old code work. Stop an incompatible older worker instead of removing these protections.
5. For an authorized disposable staging database only, restore its pre-change snapshot/recreate it if necessary, then re-verify. Production DB rollback is a separate reviewed backup/forward-fix operation; destructive down migrations are not supplied here.
6. Re-run local checks and staging readiness tests before resuming. Credential rotation is an incident response decision, not an automatic rollback step in this preparation task.

**Production gate:** no backend cutover until staging evidence, migration 0008 verification, Auth/CORS checks, provider account compatibility, delivery-risk acceptance and rollback ownership are signed off separately. No backend deployment, production migration, credential rotation or continuous worker launch is authorized by this document.
