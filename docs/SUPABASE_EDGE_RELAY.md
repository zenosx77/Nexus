# Supabase Edge relay for GitHub Pages

**Prepared and tested locally, not deployed.** No hosted migration, Auth setting,
function gateway, or connection test is confirmed. All remote operations below
require explicit approval for the named target. There are no new migrations,
schedules, worker jobs, prediction engines, or training tasks in this change.

For repeatable GitHub Actions deployment, required access, safe hosted checks and
current access limitations, see [Production relay deployment](RELAY_DEPLOYMENT.md).

## Inspected contract and implementation

The Cloud Sync configuration (`index.html`) stores `api`, `url`, `anon`, and
`record` in `nx_sb`. Set these to:

- API: `https://<project-ref>.supabase.co/functions/v1/nexus-relay`
- Supabase URL: `https://<project-ref>.supabase.co` (same project as the relay)
- Public anon key: that project's **anon** key, never its service-role key.
- Recording: existing browser mirror/delivery-recording preference.

Root-only HTTPS Node relay addresses still work. Only the fixed Edge Function
path was added to URL validation; arbitrary paths, credentials, query strings,
and fragments remain rejected. Trailing slashes are normalized by the client.

The browser uses `/auth/v1/signup` with the anon key to obtain an anonymous Auth
session, refreshes it at `/auth/v1/token?grant_type=refresh_token`, and keeps bearer
and refresh tokens in tab session storage, not public configuration. Every
protected request uses `Authorization: Bearer <access_token>`. The relay validates
it through this project's `auth.getUser`, rejects invalid/banned users, and does
not trust decoded JWT claims alone. Anonymous users may request market data;
this is the existing authorization policy, not a new private-user data model.
Telegram additionally requires a server-configured admin UUID allowlist.

The browser appends these routes to the API base:

| Route | Request | Response / authorization |
|---|---|---|
| GET `/api/v1/health` | No bearer required | `ok`, `service`, provider configured/healthy/keyCount, Telegram configuration booleans/channel booleans, `browserBudget:{dailyLimit,perMinuteLimit}`. Liveness/config only; no paid call or DB readiness claim. |
| GET `/api/v1/session` | Bearer + allowed Origin | `ok,userId,telegramAdmin,telegramConfigured,telegramChannels,cloudSyncEnabled,modelSyncEnabled` |
| POST `/api/v1/market` | Bearer + Origin + JSON `{operation,params,category?,scanReserve?}` | `{data:<scrubbed-provider-result>}`. Operations: time_series, quote, price, exchange_rate. One symbol; operation-specific parameter allowlists, bounded intervals/outputsize/precision; no URL/API key/batch input. |
| GET `/api/v1/usage` | Bearer + Origin | `{keys:[{key:"Server key 1",used,limit,error}]}`. Free api_usage; no quota reservation. |
| POST `/api/v1/telegram` | Bearer + Origin + admin UUID | Existing `{ok:true,result,...deliveryLog?}` shape. Only sendMessage, sendSticker, getUpdates, setMyCommands. Channel aliases resolve server-side; polling filters configured chats. |

Market categories are scan/ticker/settlement; scanReserve is an integer 0–6.
Telegram sends use `{method,channel,text,parse_mode?,protect_content?,record_delivery?}`
or `{method,channel,sticker,protect_content?}`. Stickers must be Telegram file IDs,
not URLs. Polling uses bounded integer offset/limit/timeout and allowlisted
allowed_updates; setMyCommands uses validated command/description objects.
Bodies are JSON objects capped at 32 KiB. Unknown fields/destinations are rejected.
Errors use `{error,...code?}`; quota errors retain HTTP 429,
`code:TWELVEDATA_BUDGET_BLOCKED`, and Retry-After when known. No arbitrary SQL,
maintenance, proxy, ingestion, training, or settlement endpoint is exposed.

CORS checks exact configured origins, never `*` or suffix matches. Preflight
allows only GET/POST and authorization/content-type headers. All protected routes
require an allowed Origin even with a valid bearer. CORS is not authentication:
non-browser callers can forge Origin but still need a validated session and any
operation-specific authorization. Health without Origin is permitted. Responses
are no-store; errors do not log requests, URLs or raw transport failures.

**Connection-test distinction:** SAVE & CONNECT tests the database, checks health,
then creates/restores a session and checks `/session`. The existing TEST CONNECTION
button (`sbTest`) checks the public database mirror and refreshes cloud views;
it does **not** independently verify the relay. A green database chip or health
response is not proof of Auth, quota readiness, successful provider calls, or a
running worker. Provider `healthy` describes isolate-local cooldown state, not a
live provider probe. Connect/health/session do not spend market credits.

`server/src/api-handler.js` is now the shared Fetch handler. `server/src/api.js`
is its Node adapter; `supabase/functions/nexus-relay/index.ts` serves its Edge
adapter with Deno. Existing provider, quota, Telegram filtering/delivery audit,
and retry modules are reused, not forked. The SDK is pinned to the Node lockfile's
version through `deno.json` and `deno.lock`. Deploy from the repository root:
the function intentionally imports shared server modules outside its directory.
No server sources or function files enter the explicit Pages build artifact.

## Shared quota prerequisites — fail closed

Inspect the existing target's schema and migration ledger before any change.
Migrations **0001 through 0009**, including 0008 privileges and 0009's shared
account RPC, are prerequisites. Follow the approval/cutover procedure in
[DEPLOYMENT_VERIFICATION.md](DEPLOYMENT_VERIFICATION.md); do not blindly replay
historical migrations or run `supabase db push` against an unreviewed project.
No new SQL is necessary for this relay.

The relay uses `reserve_twelvedata_account_credit` with browser scope. Workers
use the SAME RPC/account row. Database row locking serializes reservations:
**700 per UTC day and six per rolling minute, across users, isolates, workers,
keys and retries**, not 700 per key or process. The implementation conservatively
retains permits for 61 seconds with a maximum one-second dispatch window.
Every paid attempt reserves first; failover requires a new reservation. Errors,
ambiguous commits and stale permits are never refunded or automatically retried.
Missing/version-mismatched RPCs, invalid replies, database failure and expired
permits block provider dispatch. Redirects are disabled. Lower per-scope limits
and existing settlement headroom remain in place.

All participating account consumers must use the same Supabase project and the
updated guard/dispatch code. External consumers of the provider account that
bypass this database cannot be accounted for. Stop all consumers during an
approved 0009 cutover; its initial installation exhausts the installation UTC day
and quarantines at least 61 seconds. Never reset counters to unblock a test.

Per-user market/usage/Telegram rate buckets and provider cooldowns remain
**isolate-local secondary controls**, not distributed guarantees. The paid
account quota is database-enforced and does not reset with cold starts.
Anonymous signup abuse controls/rate limits should be reviewed separately before
public exposure. No Auth settings are changed by deployment of these files.

## Secrets and settings

Use Supabase project secrets, not Pages variables, `keys.js`, source code, browser
storage, or URL parameters. Never paste secrets into chat, logs or shell arguments.

| Setting | Requirement |
|---|---|
| SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY | Supplied by hosted Supabase Functions. Must be the same project containing 0009. For local serving only, supply local/staging values via ignored env file. |
| TWELVEDATA_KEYS | Required for market calls; comma-separated account keys. No credentials returned by health/usage. |
| NEXUS_ALLOWED_ORIGINS | Required for protected browser operations; e.g. `https://zenosx77.github.io`, **without `/Nexus`**. Add separately approved custom-domain origins exactly. No wildcards. |
| TELEGRAM_BOT_TOKEN | Optional; omit for initial staging verification. |
| TELEGRAM_MAIN_CHAT | Optional default server destination; public/vip/list/admin fall back to main. |
| TELEGRAM_PUBLIC_CHAT, TELEGRAM_VIP_CHAT, TELEGRAM_LIST_CHAT, TELEGRAM_ADMIN_CHAT | Optional server-only overrides. |
| NEXUS_TELEGRAM_ADMIN_USER_IDS | Comma-separated Supabase Auth user UUIDs. Empty denies all Telegram administration. Never infer admin from user metadata. |
| TWELVEDATA_BROWSER_DAILY_CREDIT_LIMIT, TWELVEDATA_BROWSER_PER_MINUTE_LIMIT | Default/hard maximum 700 and 6; can only lower scope limits. |
| NEXUS_API_USER_RATE_LIMIT_PER_MINUTE, NEXUS_TELEGRAM_RATE_LIMIT_PER_MINUTE | Local secondary limits, defaults 60 and 30. Usage has a local fixed 10/minute limit. |
| NEXUS_CLOUD_SYNC_ENABLED, NEXUS_CLOUD_MODEL_ENABLED | Existing session feature flags, default true; sync flag also controls relay delivery recording. |
| LOG_LEVEL | Default info. Do not add token/request logging. |

No API port, worker configuration, Telegram ops chat, Storage bucket or trainer
credential is needed merely to serve this function. The deployment does not
start Telegram retries/alerts, workers, backfill, or training. Delivery recording
remains best-effort; do not resend successful Telegram messages because audit
persistence failed. Retry delivery remains not exactly once.

## Local verification (no hosted changes)

```sh
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm test                         # includes Deno check + 32 runtime/security tests
npm run check:public
npm audit
npm --prefix server audit --omit=dev
git diff --check
# Requires a disposable local PostgreSQL DB named nexus_quota_test ONLY:
NEXUS_TEST_POSTGRES_URL='<local-test-url>' npm run test:postgres
```

The PostgreSQL suite refuses hosted database URLs and tests migration permissions,
rollback/failures, rolling windows, restart/failover behavior, independent process
concurrency and Edge/worker contention. Mock provider/Bot transports spend no
external credits. Existing prediction/training/settlement tests remain enabled.
Deno runs with `-A` only in the trusted offline test process, not as browser code.

Optional local Supabase gateway verification requires Docker + Supabase CLI:

```sh
# Use only an isolated local stack; never production credentials here.
cp supabase/functions/.env.example supabase/functions/.env
# Fill local values privately, then (after local stack setup):
supabase functions serve nexus-relay --env-file supabase/functions/.env --no-verify-jwt
```

The committed function config sets `verify_jwt=false`: the gateway must permit
unauthenticated health and OPTIONS and must not impose legacy signing-key
assumptions. **This does not disable application Auth**; every protected operation
still calls auth.getUser. Do not replace it with decode-only token checks.

## Approved staging deployment and verification

The following are instructions, not operations performed by this change:

1. Obtain explicit target/deployment approval; record revision, project reference,
   current function/config, migration evidence and rollback owner. Confirm staging
   anonymous sign-in is enabled (changing Auth settings requires separate approval).
2. With database verification approval, run the read-only scripts
   `supabase/verify/0008_read_only.sql` and `0009_read_only.sql`, and inspect
   `twelvedata_quota_status()`. They must show guard_version 1, initialized true,
   700/6 limits and rolling_window_seconds 61. Neither reserves credits.
3. Prepare an ignored, permission-restricted secrets file containing only custom
   settings (omit hosted SUPABASE_* defaults). Use a secret manager or private
   editor, not secret-bearing command arguments. Then, only after approval:

   ```sh
   supabase secrets set --project-ref <approved-staging-ref> --env-file <private-env-file>
   supabase functions deploy nexus-relay --project-ref <approved-staging-ref> --use-api
   ```

   Run from the repository root with a current CLI supporting per-function Deno
   config. `--use-api` bundles without a local Docker dependency. Review bundled
   imports and deployment output; if bundling/runtime fails, do not claim live.
   Do not add `--include-all`, apply migrations, or enable any workflow schedule.
4. Verify OPTIONS from the exact Pages origin returns 204 with the exact CORS
   origin. Check public GET health; missing/invalid bearer on session must return
   401 from an allowed origin. Disallowed Origin must return 403 with no allow
   header. Never send private secrets as browser headers.
5. Save the three public values in Cloud Sync and use SAVE & CONNECT. Confirm
   database reachability **and** session response/user UUID in browser Network.
   Verify JSON content types and no gateway JWT errors. A non-admin session must
   receive 403 on Telegram. No provider call is needed for these checks.
6. Only with separate paid-test approval and available quota, make one market
   request (one key, one symbol, no competing consumers). Check safe `{data}`,
   reservation increment and absence of credentials. Do not exhaust a live quota
   for testing. Test unavailable/exhausted guards using offline fixtures instead.
7. Telegram tests require separate approval and a dedicated test bot/chat plus
   allowlisted UUID. Confirm safe aliases/audit status; inspect uncertain sends
   before retries. Monitor 401/403/429/5xx, expired permits and audit warnings.

Production cutover requires a separate approval after staging evidence. Updating
the public Pages artifact is also a deployment; the new path validator must be
published through the approved Pages workflow before the hosted UI accepts it.

## Rollback

Stop affected consumers/traffic first; do not run incompatible old and new
consumers simultaneously. Preserve sanitized evidence and message IDs. Restore
only an approved relay revision that still uses the 0009 quota/dispatch guard,
or switch the browser back to the prior approved Node relay address. If no safe
revision exists, leave relay-dependent features unavailable rather than restoring
direct provider calls. Redeploy a known-good function only with explicit approval.

Retain all 0008/0009 restrictions, quota rows/counters and delivery provenance;
there is no down migration. Never reset usage, restore independent scope quotas,
reopen privileged RPCs or downgrade security to make old code work. Restore
allowlists/feature flags from privately recorded approved values if needed.
Do not replay uncertain Telegram deliveries. Repeat read-only verification and
connection tests before resuming. This rollback does not change models,
settlement, manual-only backfill or shadow-only training.

## Local execution evidence (2026-10-15)

- Clean root/server installs with `--ignore-scripts`: passed.
- Full `npm test`: passed; browser smoke, 97 Node server tests, 35 trainer tests,
  25 security/config/migration tests, 3 workflow contracts, 13 shared-quota tests,
  public build/artifact guard, source secret scan and actionlint. Browser smoke
  was rerun after adding exact Edge URL/health assertions and passed again.
- Deno 2.9.6 frozen-lock entrypoint check and 32 runtime API/quota tests: passed.
- Disposable PostgreSQL 17.6, Unix socket only: 22 tests passed. In particular,
  24 concurrent independent Edge/worker calls admitted six and blocked 18.
  External providers, hosted Supabase and Telegram were never contacted.
- Root and production server dependency audits: zero reported vulnerabilities.
- 45 JS syntax checks, trainer Python compilation, Supabase TOML parsing,
  `git diff --check` and `git fsck --no-dangling`: passed.
- Not executed: actual Supabase CLI gateway/bundle/deploy and hosted connection
  tests (CLI/Docker unavailable; deployment/hosted changes not authorized).
  Deno checking is not proof of hosted Edge Runtime compatibility. Separate
  PyYAML parsing was unavailable; actionlint parsed/validated all four workflows.
  External shellcheck/pyflakes were unavailable and are disabled by the existing
  actionlint wrapper. Source secret scanning is heuristic, not a history audit.

No commit, push, PR, deployment, production migration, setting change or schedule
activation was performed. Local test databases/dependencies/logs live under
ignored `.cache`/`node_modules`; they are not deployment artifacts.
