# NEXUS · Current Architecture & Security Boundaries

**Updated:** 2026-10-15 · **Working branch:** `arena/c7c0db30-nexus`

## 1. Components and data flow

| Layer | Responsibility | Security boundary |
|---|---|---|
| **Browser app (`index.html`)** | Existing 26-strategy/6-agent signal engine, session/VIP/premium logic, paper state, local learning, settlement, UI, and safe Supabase mirror. | Contains no Twelve Data key, Telegram bot token, private chat destination, or service-role credential. Browser-visible Supabase anon key is public. Predictions/deliveries remain in the existing shared/anonymous schema, not per-user-owned. |
| **Authenticated API relay (`server/src/api.js`)** | Supabase Auth bearer validation, exact-origin CORS, per-user rate limits, allowlisted market-data and Telegram operations, response filtering. | Binds on the server host; HTTPS terminates at the hosting proxy. All secrets read from server environment only. Telegram send/poll additionally requires an allowlisted Auth user UUID. |
| **Provider/Telegram transport** | `server/src/twelvedata.js` rotates provider keys and redacts provider data; `server/src/telegram.js` sends/retries and resolves destinations. | Provider API keys, Telegram bot token and destination IDs never go to browser responses. Client receives only safe data and channel aliases. |
| **Worker (`server/src/index.js`)** | Candle ingestion, backfill, outcome evaluation, risk snapshots, delivery retries, alerts, retention, settings sync. | Separate process/command from the HTTP relay. Worker retains its independent 700/day and 6/min budget. |
| **Supabase** | Existing shared tables/views and operations; atomic worker and browser-relay credit reservations; anonymous Auth session validation. | Migration 0008 removes public grants on operational/admin tables and maintenance SECURITY DEFINER functions while retaining the documented shared read/insert paths. Hosted state is not verified from this checkout. |
| **Trainer (`trainer/train.py`)** | Leakage-aware training, promotion gates, artifact integrity, rollback. | Uses service-role credentials from trainer host environment only. No background trainer was started. |

### Request flow

```text
Browser engine ── bearer Auth + exact Origin ──► NEXUS API relay
                                                   ├─ reserve shared browser credit in Supabase
                                                   ├─ Twelve Data (server-only API key)
                                                   └─ Telegram Bot API (server-only token + destination)

Browser ── Supabase anon key ──► shared prediction inserts + public-safe views
Relay ── service-role key ──► shared delivery records/retry queue (private payloads)
Worker ── service-role key ──► ingest/evaluate/risk/retries/alerts/retention
```

The market-data/Telegram relay does not move or rewrite the browser’s signal engine. The browser still requires an open tab for its strategies, signals, and paper workflow; the worker handles separate cloud operations.

## 2. API and credential rules

- Public health: `GET /api/v1/health` (safe booleans, key count, and configured browser budget only).
- Authenticated routes: `GET /api/v1/session`, `GET /api/v1/usage`, `POST /api/v1/market`, and `POST /api/v1/telegram`.
- Market operations are restricted to `time_series`, `quote`, `price`, `exchange_rate`, with per-operation parameter allowlists. API keys are added only server-side. Provider responses are scrubbed for key/token/secret fields.
- `api_usage` is free and returns aliases (`Server key 1`, …) with usage numbers only.
- Telegram accepts only `sendMessage`, `sendSticker`, `getUpdates`, and `setMyCommands`. Outbound sends resolve a channel alias on the server. Incoming updates are limited to configured chats and replace actual chat IDs with aliases before reaching the browser.
- Every non-health API route validates a Supabase Auth bearer token and checks the exact request origin against `NEXUS_ALLOWED_ORIGINS`. Production deployment requires HTTPS and a host proxy. A browser-generated anonymous Auth session is not an ownership model; it only identifies/rate-limits relay requests.
- Telegram operations additionally require the user UUID in `NEXUS_TELEGRAM_ADMIN_USER_IDS`. The allowlist and channel destinations are host settings, never browser input.
- Request/response errors and logs are redacted. No token or API key is included in browser storage, output, errors, or public responses.

### CORS and Auth setup

Set `NEXUS_ALLOWED_ORIGINS` to exact origins only (e.g. `https://your-account.github.io`, with no repository path; never `*`). Enable Supabase anonymous sign-ins for the app’s session flow. The API process binds to `0.0.0.0:NEXUS_API_PORT` (default 8787); terminate TLS at the hosting proxy and forward to this process. Keep relay and worker as separate supervised services.

## 3. Credit budgets

Migration `0007_twelvedata_credit_budget.sql` retains the worker pool. Migration `0008_cloud_security_and_browser_budget.sql` adds the browser-relay pool and hardens SQL permissions.

| Pool | Defaults | Uses | Persistence |
|---|---:|---|---|
| Worker | 700 paid requests / UTC day · 6/min | ingestion, backfill | atomic shared Supabase reservation |
| Browser relay | 700 paid requests / UTC day · 7/min | scans, ticker, settlements | separate atomic shared Supabase reservation |

The counters are per pool, shared across processes using that Supabase project, and not multiplied by configured key count. Both fail closed if Supabase reservation is unavailable. Worker ingestion uses at most 80% of its pool. Routine browser work stops at 80%, reserving the remainder for settlements, while the 700/day and 7/min caps are absolute. `api_usage` is a free request. The browser’s local counter remains a secondary UI guard only.

## 4. Database access semantics

This work intentionally preserves the current shared/anonymous database model:

- `predictions` and `trade_outcomes` remain shared records under the existing policies; no `user_id` ownership or per-user row partitioning is introduced.
- Anonymous/browser roles retain intended public reads, shared prediction inserts, and safe view reads. Delivery records and retryable payloads are written only by the authenticated server relay; anonymous delivery inserts and direct operational/admin table access are revoked by migration 0008.
- The restricted delivery view exposes status/metadata only; raw chat destinations and payloads are not public. Retryable rows are marked server-managed and created by the authenticated relay only.
- Worker tables and private credit budgets remain service-role-only.
- `try_job_lock`, `release_job_lock`, pruning functions, and credit reservations are explicitly restricted to `service_role`.

## 5. Validation and unverified deployment state

Local code/tests can validate syntax, request validation, budget math, secret-scrubbing behavior, and public artifact checks. They cannot prove the hosted Supabase project has applied migrations or has correct Auth/CORS/Storage/proxy settings.

At this update, no live Supabase migration ledger, real staging rows, storage bucket, Auth setting, or production API proxy has been verified. Migration 0008 is a file only until an operator applies and verifies it in a safe staging project. Do not claim staging or production is operational, do not apply production migrations, deploy, or start a continuous worker without explicit approval.

## Backend deployment preparation

See [DEPLOYMENT.md](DEPLOYMENT.md) for separate managed relay/worker service settings, the code-derived environment inventory, staging-first gates, bounded worker tests and rollback. Offline HTTP security tests and disposable PostgreSQL migration tests now complement the browser/trainer suites. Migration 0008 remains unconfirmed on the hosted project. Health is liveness only; delivery logging is opt-in/best-effort and retries are not exactly once.
