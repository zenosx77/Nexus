# NEXUS Glass v5.2 · Meridian

A single-file, glassmorphic **multi-pair M1/M3 signal research engine** for binary-options-style candle prediction — built around **4 Telegram channels** (PUBLIC · VIP · LIST · MAIN), bot-configured message formats, an event sticker bank, revision-safe candle settlement, and quality-first paper signals.

> ⚠️ **Signal-only + paper-trading.** NEXUS never places, clicks, or automates real trades. No system can guarantee a win rate. Binary options carry a very high risk of loss.

## Product features

- **26 strategies + 6 agents** across M1/M3, with live/deep/regime weights, risk gates, and paper-trading controls. The browser strategy and signal logic remain unchanged by the cloud relay.
- **PUBLIC stream:** quality-only signal per minute; skips when no setup qualifies.
- **VIP stream:** best qualifying setup every 10 minutes; skips rather than lowering the quality floor.
- **Premium lists:** scheduled unique-pair windows, with a conviction floor that is never silently relaxed.
- **Stable verification:** waits through a provider revision window and settles from the exact target candle; ties are pushes.
- **Paper-first production gate:** production signal/list sending stays locked until the configured validation evidence exists. Passing a gate never guarantees future results.
- **Bot-configured formats and sticker bank:** `/setformat`, `/formats`, `/resetformat`; unassigned stickers are never sent.
- **Product polish:** responsive pages, reduced-motion support, toast feedback, online status, and Ctrl/⌘ K actions.

## Security and deployment model

The browser does **not** call Twelve Data or Telegram directly. It calls an authenticated NEXUS API relay. These values stay on the server host only:

- `TWELVEDATA_KEYS`
- `TELEGRAM_BOT_TOKEN` and Telegram destination IDs
- `SUPABASE_SERVICE_ROLE_KEY`

The browser receives only provider data and server-configured channel aliases. It uses the public Supabase anon key for the existing shared/anonymous schema; prediction and delivery records are not per-user-owned. The browser may insert shared prediction records, while delivery payloads and retryable attempts are written by the authenticated server relay and exposed only through a restricted status view. A Supabase Auth session is required for API relay requests and Telegram operations; Telegram sending/polling also requires the session’s user UUID in `NEXUS_TELEGRAM_ADMIN_USER_IDS`.

## Local checks

```bash
npm ci --ignore-scripts             # Node 22+; local test dependencies
npm --prefix server ci --ignore-scripts
npm test                            # browser + server + trainer + security + artifact scan
npm run test:browser                 # browser suite only
```

The static UI has no bundler/CDN. Serve the repository root over HTTP for local development; HTTPS is required for a non-local relay URL. The Pages workflow publishes `index.html` and fonts and runs `tools/check-public.cjs` before upload. It does not publish `keys.js` or server environment files.

## Setup

**Deployment preparation:** use [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the staging-first hosting, environment, verification and rollback checklist. GitHub Pages alone does not host a backend. The commands below describe runtime modes, not authorization to start a continuous worker.

1. Review `SUPABASE_SETUP.md`; manually apply migrations `0001`–`0008` in order to a safe Supabase project and verify the resulting grants, policies, views, and functions. Create the private `models` Storage bucket only if using those workflows. **The migration files are not evidence that a hosted database has applied them.**
2. Enable anonymous sign-ins in Supabase Auth for the browser relay.
3. On the server host, copy `server/.env.example` to `server/.env` and enter the Supabase service-role key, private Twelve Data keys, API origin allowlist, and (if used) Telegram token/destinations. Never put these secrets in the app, a browser file, build output, or chat.
4. Run the API relay and worker as separate supervised processes:

```bash
cd server
npm run api       # binds 0.0.0.0:NEXUS_API_PORT (default 8787); TLS at the host proxy
npm start         # worker loop, separately supervised
```

Configure `NEXUS_ALLOWED_ORIGINS` as comma-separated exact browser origins (scheme + host, no path; never `*`). Add `NEXUS_TELEGRAM_ADMIN_USER_IDS` after the app displays the Supabase Auth user UUID. The relay’s CORS, authentication, per-user rates, endpoint/parameter allowlists, and persistent SQL credit reservation are complementary controls; do not expose an unconfigured relay publicly.

5. In the app’s **CLOUD** page, enter the public relay URL, Supabase project URL, and **anon public key**, then **SAVE & CONNECT**. The app stores only public Supabase configuration and the Auth session; it never stores provider keys, bot tokens, or private chat IDs.

Full migration, host, auth, and verification instructions: **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** · [server guide](server/README.md) · [architecture](docs/ARCHITECTURE.md).

## Credit controls

After approved migration **0009**, one locked PostgreSQL account row enforces **700 paid requests per UTC day and six per rolling minute across ALL workers, browser relays, retries and API-key failovers**. The rolling window is conservatively 61 seconds with a maximum one-second dispatch permit. No key or process gets an independent account allocation.

Scope settings may only lower these hard ceilings. Browser routine requests still preserve settlement headroom; worker ingestion retains its 560/day planning allowance, but neither scope owns a guaranteed allocation of the shared 700. The public UI counter is secondary and cannot observe other clients' usage. Free `api_usage` reads do not reserve paid credits.

**Do not activate on 0007/0008 alone.** The updated server requires the versioned shared RPC and fails closed if unavailable, malformed or slow. Migration 0009 intentionally quarantines its installation day; no budget counters may be reset to bypass this. Every consumer of the provider account must use this same database and updated server. See [the approval-gated deployment report](docs/DEPLOYMENT_VERIFICATION.md).

## Telegram setup

1. Set the server-only bot token and channel destinations in `server/.env` (`TELEGRAM_MAIN_CHAT`, optional PUBLIC/VIP/LIST/ADMIN destinations, and `TELEGRAM_OPS_CHAT`). Unset browser destinations fall back to MAIN.
2. Add the bot as administrator where needed; set the connected Supabase Auth user UUID in `NEXUS_TELEGRAM_ADMIN_USER_IDS` on the server.
3. On the TELEGRAM page, authorize the allowlisted session, pull stickers from the server-configured admin chat, and use the format/automation controls. Token and chat IDs are never displayed or stored in the browser.
4. Browser command/listener and message sends are relayed through the authenticated API. Worker retries and ops alerts remain server-side.

Browser timers still require an open, awake page for the existing client-side strategy and signal engines. The relay and worker do not move the prediction engines to the server. The worker’s continuous operation must be explicitly supervised; no live database has been verified from this checkout.

## Cloud data semantics

The cloud mirror intentionally remains **shared/anonymous**: browser-originated predictions remain shared records, and delivery attempts remain shared operational records under the existing schema. Delivery payloads are written only by the authenticated server relay; anonymous clients can read only the restricted status view and cannot forge retryable rows. Do not interpret these records as per-user ownership. `0008_cloud_security_and_browser_budget.sql` hardens direct public privileges and maintenance function execution and adds the historical browser scope budget (0009 subsequently places both scopes under one shared account cap), while keeping the existing prediction/read model and engines intact.

Simulated performance shown anywhere is a signal-quality metric, never realized account profit.

## Repo map

- `index.html` — browser UI, engines, local strategy state, and authenticated relay client
- `server/src/api.js` — authenticated HTTP relay; Twelve Data/Telegram secrets stay server-side
- `server/src/` — worker, provider budget, Telegram transport, ingestion/evaluation/risk/alerts
- `server/.env.example` — server-only settings template
- `trainer/` — Python training and promotion pipeline
- `supabase/migrations/` — versioned database schema and policy/credit-budget updates
- `tools/check-public.cjs` — static deployment credential guard
- `tests/smoke.cjs` / `server/test/` — local regression and unit tests
- `SUPABASE_SETUP.md` — detailed setup and verification checklist

## Scheduled jobs and deployment approval

See [Deployment verification and phone runbook](docs/DEPLOYMENT_VERIFICATION.md) for local results, production blockers, read-only SQL, approval gates and rollback. Weekly training is shadow-only; it requires Node 22 as well as Python. No production readiness or profitability is implied by offline tests.
