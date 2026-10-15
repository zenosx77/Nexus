# Repeatable production relay deployment

Target: **rxswndsebvaqztshbmlc**, function **nexus-relay**. This runbook does
not assert that a production deployment or authenticated session has passed.
See the Actions run's verification summary for actual PASS/FAIL/SKIP results.

## What the workflow does

`.github/workflows/deploy-relay.yml` runs only trusted `main` code, uses pinned
actions and CLI, read-only GitHub permissions, a `supabase-production` environment,
a 15-minute timeout and serialized deployments. It:

1. Installs both locked dependency trees and runs `npm test` (including the public
   artifact guard, Auth/Edge tests, deployment safety tests and workflow lint).
2. Runs the existing 0008 and 0009 **read-only** SQL verifiers through the Supabase
   Management API. Missing schema, unsafe privileges or a missing quota contract
   fail closed. It never applies migrations or reserves a quota credit.
3. Checks the fixed project/origin, management token and project-matching public
   anon JWT. Synchronizes the exact origin and only nonempty supplied optional
   secrets, using an owner-only temporary env file, removed even on failure.
   Empty optional GitHub secrets **preserve** hosted secrets; they do not delete
   them. To revoke a secret, remove it explicitly in Supabase as well.
4. Deploys the existing function using `supabase functions deploy ... --use-api`
   from the repository root (includes shared server imports). CLI output is
   withheld to avoid accidental secret disclosure. A deploy failure is not success.
5. Checks health, exact CORS, preflight, application rejection of missing/invalid
   bearers, disallowed origins, public Cloud Sync reads, anonymous Auth signup,
   **the actual authenticated session endpoint**, matching user identity and
   Cloud feature flags, authenticated database access, and a free Twelve Data
   `/usage` lookup. The temporary Auth session is signed out in `finally`.

The signup creates one anonymous Auth user per run; logout invalidates its refresh
session but does not delete that user. No tokens, user IDs, response bodies or
prices are logged or saved as artifacts. Reports contain fixed check names and
PASS/FAIL/SKIP only. Cleanup failure fails verification too.

The workflow does **not** alter the database, RLS, signals, prediction/outcome
engines, trainer, model promotion, scheduled jobs or static website. Existing
`verify_jwt = false` is preserved for public preflight and modern Auth signing
keys; application-level `auth.getUser` still validates every protected request.
This is not an authentication bypass. Do not turn it into an unauthenticated relay.

## One-time operator configuration (one consolidated checklist)

1. Create/configure GitHub environment **supabase-production**. Restrict deployment
   branches to `main`; add reviewers if desired. Add these environment secrets
   in GitHub Settings, never in chat, source files or Pages:
   - **SUPABASE_ACCESS_TOKEN**: authorized Supabase management token with access
     to this project, database read-only verification, function deployment and
     secrets management. Not the anon key and not a database/service-role key.
   - **SUPABASE_ANON_KEY**: this project's legacy **public anon JWT**, matching
     the website's existing REST Authorization contract. Wrong-project and
     privileged keys are refused. No service-role key is needed in Actions.
   - **TWELVEDATA_KEYS** if not already configured in Supabase: comma-separated
     private account keys. Leave empty to preserve the existing hosted value.
   - For Telegram, if not already hosted: **TELEGRAM_BOT_TOKEN**,
     **TELEGRAM_MAIN_CHAT** and any intended **TELEGRAM_PUBLIC_CHAT**,
     **TELEGRAM_VIP_CHAT**, **TELEGRAM_LIST_CHAT**, **TELEGRAM_ADMIN_CHAT**;
     **NEXUS_TELEGRAM_ADMIN_USER_IDS** contains authorized Auth UUIDs, not metadata.
     Do not overwrite an existing allowlist with only a test user.
2. Review the existing Supabase deployment, not just repository SQL: migrations
   0001–0009 and private `models` bucket. The automatic read-only verifiers check
   schema/RLS/grants/quota prerequisites but do not apply missing migrations or
   prove all external provider consumers use the shared quota. If they fail,
   review the dashboard and [cutover runbook](DEPLOYMENT_VERIFICATION.md).
   Do not replay migrations, reset counters or run `db push/reset` to unblock a
   test. In particular, 0009 needs the documented approved consumer cutover.
   Anonymous Auth is already reported enabled; the live signup check confirms it.
   Hosted Functions supply `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Run **Deploy and verify NEXUS relay** from Actions on **main**. This sets
   `NEXUS_ALLOWED_ORIGINS=https://zenosx77.github.io` (no `/Nexus` path), deploys,
   and produces the authenticated-session verification result. After the first
   successful run, optionally set repository variable
   **NEXUS_RELAY_DEPLOY_ENABLED=true** for automatic deployments on relay changes.
   Manual runs remain available without that variable. Environment protection
   rules still apply. Any FAIL requires investigation; SKIP is never a pass.
4. To complete the optional end-to-end probes, run manually with:
   - **verify_market=true**: one `price EUR/USD` relay request. The existing
     provider may fail over keys and consume multiple paid credits, each reserved
     through the same database quota. There are no smoke-script retries or quota
     bypasses. A 429 is a failed/blocked live check, not successful market access.
   - **verify_telegram=true**: set environment secrets **TELEGRAM_ADMIN_CHAT** to
     an explicitly chosen **private test/admin chat** (bot must have access) and
     **NEXUS_VERIFY_ADMIN_ACCESS_TOKEN** to a current short-lived Auth bearer for
     an already allowlisted administrator. Supply through GitHub's secret UI,
     never through workflow inputs/chat/CLI arguments. The workflow synchronizes
     the explicit admin destination before sending so it cannot silently fall
     back to MAIN. Confirm this routing change is appropriate for the live app.
     The script verifies the bearer is an admin and sends exactly one labelled
     “NOT A TRADING SIGNAL” message to alias `admin`, with delivery recording off.
     No signal/audit/retry rows or Telegram polling/command changes are generated.
     There are no automatic send retries. If the response is lost, inspect the
     private chat before considering another manual run. Remove the short-lived
     test bearer from GitHub after verification.
5. On the website's CLOUD page, save/connect with:
   - Relay: `https://rxswndsebvaqztshbmlc.supabase.co/functions/v1/nexus-relay`
   - Database: `https://rxswndsebvaqztshbmlc.supabase.co`
   - The project's public anon key.
   This browser-local setting cannot be provisioned through repository deployment.
   SAVE & CONNECT verifies the relay; TEST CONNECTION alone only checks the DB.

Cloud Sync smoke checks are deliberately **read-only**. Insert privileges and RLS
are checked by SQL and disposable-database tests; no artificial production
prediction/outcome or training record is inserted. A successful read does not
claim the full production prediction/settlement/training lifecycle was exercised.

## Pages and rollback

GitHub API inspection found Pages already configured with `build_type=workflow`,
HTTPS enforced, and URL `https://zenosx77.github.io/Nexus/`. The existing Pages
workflow succeeded for inspected `main` commit `b5ea8b00fa644ecd73ac7fdc00d2167d475054ec`
(run `38774899698`). Direct browser availability was not verified from this sandbox.
No Pages setting change or credential-bearing public configuration is required.

To roll back function code, revert the relevant code change through a reviewed
PR on `main` and rerun the workflow. Do not reset the database or restore old quota
RPCs. Secret changes are separate: reverting code does not restore their values.

## Access observed during preparation

No Supabase management/provider/Telegram credentials were available to this agent.
GitHub API access to repository secrets and variables returned HTTP 403, so their
existence/absence could not be established. The environment only permits outbound
traffic to GitHub/package registries; direct Supabase and Pages requests failed
TLS connection establishment. Consequently, function deployment, hosted SQL,
authenticated `/session`, Cloud Sync, Twelve Data and Telegram **remain unverified**.
The current session's GitHub permission cannot provision or inspect these secrets;
use the Settings UI or authorize the appropriate connection permissions. Never
paste credentials into the conversation.
