# Backend preparation verification — 2026-10-15

## Scope and outcome

Repository-only preparation on `arena/7034b734-nexus`. No backend was deployed, no hosted database was contacted/migrated, no credentials were rotated, no production settings/Pages workflow were changed, and no continuous worker was started. The approved tests used short-lived loopback HTTP servers, fake transports and disposable in-memory PostgreSQL.

**Local result: PASS. Hosted readiness: NOT VERIFIED.**

## Executed checks

| Check | Result |
|---|---|
| Initial browser smoke suite | PASS |
| Initial server suite | 53/53 PASS |
| Initial trainer suite | 29/29 PASS |
| Final root `npm test` (all suites and public-artifact scan) | PASS |
| Final server suite | 71/71 PASS |
| Final trainer suite | 29/29 PASS |
| Final migration/scanner/environment security suite | 25/25 PASS, including nested tests |
| Final extended browser smoke/regression suite | PASS |
| Pages-equivalent local artifact guard | PASS; HTML and license scanned, font binary copied |
| `npm --prefix server ci --ignore-scripts` | PASS with committed lockfile |
| Root and server production dependency audits | 0 reported vulnerabilities |
| `git diff --check` | PASS |

Runtime used: Node v22.22.3, npm 10.9.8. Test logs/generated public files are local ignored `.cache` artifacts, not release assets committed to Git. A clean checkout reproduces with Node 22+, Python 3, root/server `npm ci --ignore-scripts`, then `npm test`.

## Security coverage and fixes

- Exact CORS origins, preflight methods/headers, public health exception, missing/invalid/banned Auth, Auth outage, protected routes and admin-only Telegram.
- Object-only JSON, content type/body limits, provider operations/parameters/symbol/outputsize/interval checks, Telegram command/message/sticker/polling validation and rejection of inherited-property channel aliases.
- Per-user throttle enforcement/reset/isolation, free usage throttle, independent RPC pool/default arguments, fail-closed unavailable/malformed guards, provider reservation-before-fetch and reservation on each failover attempt.
- Configured and patterned secret redaction in logs, errors, provider responses and safe Telegram updates. Public scanner fixtures include encoded service-role JWTs, secret-key/token formats, source maps, private destinations, direct transport, env/source files and symlinks. Diagnostics do not print matched secret values.
- Relay delivery provenance/status/alias persistence, failed send logging, honest persistence warning without duplicate resend, and bounded worker retries with historic-row exclusion and persistence-error detection.
- Browser signup/refresh/bearer/JSON transport, failed Auth preventing paid transport, legacy-key stripping, no direct provider transport, and restored-session expiry preservation.
- Migrations 0001–0008 execute in PGlite with pgcrypto and simulated Supabase roles/grants. 0008 reapplication/read-only assertions, RLS prediction constraints, operational/RPC denials, delivery provenance, public views, daily/minute boundaries, UTC rollover and browser settlement/scan reserves pass.
- Fresh-install SQL error found in 0004: reserved `window` identifier lacked quotes. 0004/0006 now quote the existing column without renaming it. Migration 0008 itself did not require changes for these local checks.
- Template inventory is checked against actual server configuration reads; secret values remain placeholders and limits stay browser **700/day, 7/minute**, worker **700/day, 6/minute**.
- Server dependency lockfile added; Node minimum raised to 22 to match the resolved Supabase SDK, rather than claiming unsupported Node 18 compatibility.

## Outstanding staging gates / accepted limitations

- Hosted migration 0008, actual Supabase grants/ledger/Auth/PostgREST/Storage, host TLS/port/CORS, real provider plan and Telegram destinations remain unverified. Run `supabase/verify/0008_read_only.sql` only under future staging authorization and complete [DEPLOYMENT.md](DEPLOYMENT.md).
- PGlite serializes a single connection; queued reservation tests are not a multi-connection contention proof. Actual row-lock concurrency needs staging verification.
- `/api/v1/health` is liveness/configuration reporting, not dependency or worker readiness. Per-user throttles are process-local; anonymous Auth and CORS do not provide a private operator gate. Upstream abuse controls remain necessary.
- Delivery logging remains opt-in/best-effort, not a transactional outbox or complete audit; stickers are not persisted for retry. Retries do not preserve all send options and cannot guarantee exactly-once delivery. Inspect uncertain sends before replaying.
- Browser/worker budgets are separate but may spend against the same provider account; combined account capacity must be reviewed. A static scanner cannot recognize every arbitrary private value; maintain the explicit public file allowlist.

No production cutover is approved by these passing local checks.

## Dashboard truth and policy decisions (2026-10-15 follow-up)

- **Cloud Sync chip** is derived from checks, not configuration: `CONFIGURATION REQUIRED`, `OFFLINE`, `CONFIGURED · NOT VERIFIED`, `CONNECTING`, `OFFLINE · database unreachable`, `DATABASE OK · relay not authenticated`, and `SYNC ON` only after both a successful anon database read and a successful relay session. Configuration changes reset verification.
- **Relay health** is labelled `relay: reachable` (liveness only).
- **Market Data Health** shows the worker's latest recorded ingestion run (status, age, candles upserted, gaps) above candle freshness. It shows `NO WORKER RUNS` when none exist and `STALE` after 15 minutes. It never infers worker liveness from relay health.
- **Telegram Delivery Log** copy no longer claims a message "can never double-send"; delivery is best-effort and not exactly-once.
- **Cloud Performance** is labelled as including browser-submitted signals, not independent verification; returns are simulated after estimated spread and slippage, and win rate is not profitability.
- **Anonymous prediction mirror policy (decided):** the existing shared browser mirror is retained, because changing its RLS would alter the shared-data design and requires a separate, approved migration. Its effect on global metrics is disclosed in the UI and here. Restricting it remains an open option.
- Staging (hosted Supabase, Render, migration 0008, bounded worker test) was **not** performed: no staging project or host was provided, and this sandbox cannot reach those services.
