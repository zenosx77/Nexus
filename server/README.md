# NEXUS server worker + authenticated API relay

The Node service has two independent modes:

- **Worker** (`npm start`) — market-data ingestion, outcome evaluation, risk snapshots, Telegram retries/alerts, and retention.
- **API relay** (`npm run api`) — authenticated browser requests to Twelve Data and Telegram. Provider keys, Telegram tokens/destinations, and the Supabase service-role key stay in the server process environment.

The public GitHub Pages app never calls Twelve Data or Telegram directly and never receives their credentials. The browser may use the public Supabase anon key for the existing shared/anonymous prediction mirror. Delivery audit rows and retryable payloads are written by the authenticated relay with the server role, never inserted by anonymous browser clients. Prediction and delivery records are **not user-owned**.

## Deployment preparation

See [the staging-first deployment runbook](../docs/DEPLOYMENT.md). Recommended managed topology: a Node web service for the relay and a separate background-worker service. No backend host or hosted migration 0008 is verified. Use Node 22+ and the committed server lockfile; the current Supabase SDK requires Node 22. The app reads `NEXUS_API_PORT`, not `PORT`. No continuous worker is authorized by repository preparation.

## Setup

```bash
cd server
npm ci --ignore-scripts
cp .env.example .env       # use real host values; never commit server/.env
```

Set the environment values on the server host. At minimum, the relay needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TWELVEDATA_KEYS`, `NEXUS_ALLOWED_ORIGINS`, and the API port. Telegram requires `TELEGRAM_BOT_TOKEN`, destinations, and an allowlisted Supabase Auth user UUID in `NEXUS_TELEGRAM_ADMIN_USER_IDS`.

Apply and verify the SQL migrations manually using `supabase/README.md`; **migration files are not proof that a hosted project has applied them**. The worker also uses a private Storage bucket named `models` only when archive/model workflows are enabled. Enable anonymous Supabase Auth sign-ins for the browser relay, and set the project’s allowed redirect/origin configuration appropriately.

`NEXUS_ALLOWED_ORIGINS` is a comma-separated exact list of browser **origins** (scheme + host + optional port, no path); do not use `*`. For GitHub Pages, include the site origin such as `https://your-account.github.io`. Terminate TLS at the hosting proxy and forward to the API process. The API binds to `0.0.0.0`.

## Run

```bash
npm run api              # authenticated HTTP relay on NEXUS_API_PORT (default 8787)
npm start                # continuous worker loop (run as a separate supervised process)
npm run once             # one full worker pass, then exit (cron-friendly)
npm run ingest           # single job entrypoints, for debugging / scheduling:
npm run evaluate         #   each is lock-protected (job_locks table)
npm run telegram         #   two workers cannot double-process a locked job
npm run alerts
npm run backfill         # find + fill gaps from the last 24h
npm run housekeeping     # prune logs/snapshots/candles (+ archive first when enabled)
npm run settings-sync    # write effective non-secret settings to system_settings
npm test                 # offline tests; HTTP uses loopback and fake transports
```

Use separate service definitions for `npm run api` and `npm start`. Do not run a continuous worker on a developer laptop that sleeps. Example PM2 commands (after reviewing host values):

```bash
pm2 start npm --name nexus-api -- run api
pm2 start npm --name nexus-worker -- start
pm2 save
pm2 startup
```

These process commands are for a separately approved deployment, not the local preparation/test workflow. `npm run once` is side-effecting and includes retention, alerts and sends; use the bounded staging ingestion procedure in the runbook instead.

The static website and server are separate. The browser tab still runs NEXUS’s existing strategy, signal, and paper-trading engines; the API relay supplies only the market-data and Telegram transport. A configured relay does not itself prove the worker is online.

## API relay security

The public health route is liveness/configuration only: it does not verify database migrations, Auth, upstream connectivity or worker activity.

- All browser routes except `/api/v1/health` require an authenticated Supabase Auth bearer session and an allowed `Origin`.
- The app creates/restores an anonymous Auth session using the public anon key. It stores that browser session in `sessionStorage`; it is not a server secret and does not change the shared database ownership model.
- Twelve Data operations/parameters are allowlisted. Keys are selected server-side and scrubbed from provider responses/errors. Paid requests reserve from an atomic Supabase budget **before** contacting the provider; a failed guard blocks the request.
- `api_usage` is free and returns aliases such as `Server key 1`, never key material.
- Telegram supports only sendMessage, sendSticker, getUpdates, and setMyCommands. The route resolves channel aliases on the server, filters incoming updates to configured chats, replaces chat IDs with aliases, and allows sending/polling only for user IDs in `NEXUS_TELEGRAM_ADMIN_USER_IDS`. Requested message delivery attempts/payloads are inserted by the relay as server-managed rows; logging is opt-in/best-effort and `deliveryLog.recorded` reports persistence. Sticker sends are not retry-logged; anonymous callers cannot create rows that the worker will retry.
- API, Telegram, and usage rate limits are additional in-process controls; the persistent Twelve Data credit budget is the authoritative shared quota. Do not expose the relay without its origin allowlist and upstream proxy controls.

## Twelve Data credit budgets

Review migrations 0001–0009 and apply missing migrations **only after explicit approval**. The account-wide guard in 0009 is required by the updated relay/worker. One row lock serializes all scopes/API keys. Hard ceilings are 700/UTC day and six/rolling minute, conservatively implemented as 61 seconds plus a maximum 1000ms dispatch allowance. A reservation is never refunded, even on provider failure or ambiguous response. A missing/expired guard blocks provider transport.

The old worker/browser RPC names route through the same shared function; the service role can read but cannot directly insert/update/delete/truncate budget tables. Browser scan/settlement reserve rules and configurable lower scope limits remain secondary controls. `TWELVEDATA_*_CREDIT_LIMIT` values cannot increase the database hard ceilings.

`INGEST_PAIRS` remains configurable. Scheduled ingestion handles at most six paid attempts each half hour: at most 288/day, below the 560 worker planning allowance. Ten active pairs typically refresh in roughly 60 minutes under the scheduled mode; deferred calls/shared competition can be slower. The legacy continuous loop retains credit pacing, not a guaranteed refresh SLA. Backfill is manual only. Every key/account consumer must use the same Supabase guard; external direct-key users are not controlled by it. Use the free provider usage lookup for reconciliation, never counter resets.

A fresh 0009 installation reserves all 700 for its current UTC day and blocks at least 61 seconds to avoid granting unknown legacy usage twice. Stop all consumers before cutover; restart only after quarantine and verification. See [deployment report](../docs/DEPLOYMENT_VERIFICATION.md) for approval gates and safe rollback.

## What each worker job does

| Job | Cadence | Behaviour |
|---|---|---|
| `ingest` | credit-paced (at most 80% of worker daily cap) | Fetch 1-min candles for rotating active pairs, reserve one credit before each paid request, validate completed candles, upsert with duplicate/revision detection, compute `nexus-f1` features, record `ingestion_runs`. |
| `evaluate` | every poll | Evaluate elapsed predictions using target-candle open/close, estimated spread/slippage, and insert-only outcomes; missing candles after the configured delay become invalid. |
| `telegram` | every poll | Retry recorded `failed`/`retrying` delivery attempts up to `TELEGRAM_RETRY_MAX`. |
| `alerts` | every poll | Data lag, missing evaluations, delivery failures, win-rate and losing-streak alerts, deduplicated in `alert_log` and sent to the ops chat. |
| `risk` | 5 min | Rolling w20/w100/all snapshots per scope; accuracy remains separate from simulated returns. |
| `backfill` | manual only | Detect and fill gaps ≥3 min from provider history. |
| `housekeeping` | 24 h | Sweep job locks and prune operational logs, risk snapshots, and candles. Optional archival is controlled by `ARCHIVE_BEFORE_PRUNE`. |

## External services

| Service | Used for | Environment |
|---|---|---|
| Supabase | database + Auth + optional Storage | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Twelve Data | worker + relay market data | `TWELVEDATA_KEYS` (comma-separated, rotated) |
| Telegram Bot API | browser relay, worker retries, ops alerts | `TELEGRAM_BOT_TOKEN`, server-side chat destinations, `NEXUS_TELEGRAM_ADMIN_USER_IDS` |

## Tests

`npm test` runs logic plus loopback HTTP tests with fake Auth/database/provider/Bot transports; no hosted Supabase or provider access and no real credentials are used. Root `npm test` also runs disposable PGlite migrations/role tests, the trainer/browser suites and the public artifact scan. See the runbook for limitations: PGlite is not a hosted or multi-connection verification, and Telegram delivery is not exactly once. Live migrations, CORS/proxy behavior, Auth settings, staging data, and provider quotas must be verified separately in a safe staging project before production use.

## Scheduled deployment

See [the verified implementation report and phone runbook](../docs/DEPLOYMENT_VERIFICATION.md). Scheduled jobs are separate from `loop`/`once`, never generate predictions or send Telegram, and require production approval. Backfill is now manual in every worker mode. Migration 0009 supplies the shared account cap locally; hosted installation, all-consumer cutover and verification remain blockers to activation.
