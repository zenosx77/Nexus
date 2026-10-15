# NEXUS deployment verification and shared-quota cutover

**2026-10-15 — implementation verified locally; production NOT activated.**

## 1. Repository state and commits

Continuation inspection found the prior turn's files restored as uncommitted changes over `b953f6638024dc9bb641510996078303810e80aa` on `arena/262a1d23-nexus`. Reported commits `87d3003` and `78a2996` were absent from both object storage and reflog. No work was discarded, reset, or force-pushed. The inherited suite was rerun successfully before preserving it.

- `8cbbb61` — preserve the restored scheduled jobs/trainer integrity implementation.
- `1c23103` — atomic account-wide quota, server integration, regression/concurrency tests and verification CI.
- `31fc256` — deployment report, PR draft and setup/cutover guides.
- `9f2539f` — confirmed publication/CI evidence; clean local and remote HEAD at continuation inspection.

Only the session branch is used. PR creation and merging require separate approval. The current user instruction conditionally permits a normal branch push after access and verification checks; push success must be confirmed from GitHub, not inferred from local commits. **Confirmed publication:** normal push exited 0; `git ls-remote` matched `31fc25652b12cbdfc3da103c76b0ce0ef841bd01` on the session branch. No PR was opened. [GitHub offline verification run 38709335739](https://github.com/zenosx77/Nexus/actions/runs/38709335739) completed successfully at that commit; `gh run watch --exit-status` exited 0. The final execution response reports the documentation follow-up state.

## 2. Atomic shared quota implementation

### Database — migration 0009 (prepared, NOT applied to production)

`supabase/migrations/0009_shared_account_quota.sql` adds a singleton `twelvedata_account_budget` row. Every worker/browser reservation obtains `SELECT ... FOR UPDATE` on that **same row**, then uses database time **after** acquiring the lock. The row lock is held until the transaction commits; account and scope updates commit or roll back together.

- Hard account ceilings: **700 paid reservations per UTC day; six per rolling minute**, independent of user, process, scope, retries or key count. Caller parameters can only lower limits.
- Conservative rolling window: **61 seconds**, with at most **1000ms** from RPC initiation to provider dispatch. The server checks the permit again immediately before fetch; permits also expire at UTC midnight. This avoids a late reservation being dispatched after its accounting window. Provider arrival latency beyond dispatch is not under application control.
- Every paid attempt reserves first, including provider errors and API-key failover. There are no refunds or reservation retries after an ambiguous commit. Slow/failed reservation responses may consume capacity without a provider request; this is intentionally safe underuse.
- Legacy worker/browser RPCs now delegate to the shared function. They cannot create separate allowances. All clients must nevertheless be upgraded before restart to enforce short dispatch validity as well as database reservation limits.
- Scope counters are retained as secondary controls and audit state: browser routine 80% settlement headroom, ticker scan reserve, and lower configurable limits still apply. Neither scope owns an additional 700 calls.
- RLS enabled; public/anonymous/authenticated roles cannot read/mutate/reserve quota. `service_role` may read counters and invoke definer RPCs, but **cannot directly INSERT/UPDATE/DELETE/TRUNCATE quota tables**. Functions use a fixed `pg_catalog` search path and schema-qualified objects.
- A missing account row, regressed clock, invalid arguments, SQL failure or unavailable RPC fails closed. No request creates a replacement account row. Table constraints prevent counters above 700 or more than six recent permits.
- **Safe initial installation:** reserve all 700 for the installation UTC day and quarantine for at least 61 seconds. Earlier unobserved account usage is unknowable; assume exhausted rather than create unsafe headroom. Reapplication does not reset an existing row. This is a deliberate downtime cost, not evidence of 700 actual provider calls.

### Server/browser integration

`server/src/credit-budget.js` uses only the versioned shared RPC, with no fallback to the old independent guards. It rejects malformed/version-mismatched responses, invalid counters and stale permits; errors do not echo database response bodies. The provider transport rechecks freshness at dispatch and stops failover on a quota failure. Paid provider calls and free usage lookups explicitly reject HTTP redirects: following one automatically could issue another request without a fresh reservation.

The per-job six-attempt counter is claimed synchronously **before awaiting** the DB, fixing a local concurrency race. Browser/worker config is clamped to 700/day and six/minute; the browser secondary default and explanatory UI now match six. Existing diagnostics/ticker tests explicitly cover deferral when the stricter limit leaves no headroom.

Preflight checks the shared capability using read-only `twelvedata_quota_status()`, not a quota reservation. It still returns `productionReady: false`: hosted policies, all-consumer cutover, provider behavior and operator approval are additional gates. An inherited preflight typo (`feature_snapshots`, nonexistent) was corrected to `market_features`, with an actual migrated-schema test.

### Preserved functionality

Prediction engines, weight merging, canonical model validation, browser prediction mirroring, Telegram delivery/retry logic, outcome tracking and 90-minute missing-candle waiting remain intact. No prediction generator was added to the worker. Backfill remains manual-only, including legacy loop/once. Training remains weekly, shadow-only, with eligible-outcome filtering and purged chronological evaluation boundaries. No active model was changed. Replay metrics remain simulated, never evidence of trading profitability.

## 3. Automated verification evidence

Environment: Node 22.22.3, Python 3.11.2, disposable **PostgreSQL 17.6** (Unix socket only, under ignored `.cache`; no public DB port). Test DB is `nexus_quota_test`. The test runner refuses hosted URLs and any other database name. `pg` 8.16.3 is an exact dev dependency; database binaries were downloaded through npm into ignored local tooling, not committed.

| Check | Actual result | Exit |
|---|---|---:|
| Clean root and server `npm ci --ignore-scripts` | Passed | 0 |
| Complete root `npm test` | Passed all component checks below | 0 |
| Browser smoke | Passed one unnumbered assertion suite | 0 |
| Server tests | **85 passed**, 0 failed/skipped | 0 |
| Python trainer | **35 passed** | 0 |
| Security/migration/public-guard/config tests | **25 passed**, 0 failed/skipped | 0 |
| Workflow contracts | **2 passed**, 0 failed/skipped | 0 |
| Shared quota PGlite tests | **13 passed**, 0 failed/skipped | 0 |
| `npm run test:postgres` on real PostgreSQL | **21 passed**, 0 failed/skipped | 0 |
| Public build and artifact scan | Passed; 2 text assets | 0 |
| Source credential scan | Passed; 83 text files, 4 exact pre-existing synthetic token occurrences excluded | 0 |
| Root `npm audit`; server `npm audit --omit=dev` | Each reports **0 vulnerabilities** | 0 |
| Workflow actionlint | All **4** workflows pass | 0 |
| YAML parse with PyYAML | All **4** workflows parse | 0 |
| JS syntax / Python compile | **43 JS** files and **2 Python** files pass | 0 |
| `git diff --check` (including final cumulative diff) | Passed | 0 |
| CLI preflight with missing configuration | Expected redacted failure; NOT hosted preflight | **1** |

TAP totals include parent/subtests as reported by Node, not invented assertion counts. Detailed local logs are in ignored `.cache`, not published artifacts.

**Real concurrency evidence:** 40 parallel mixed-scope requests on independent PostgreSQL connections admitted exactly six and denied 34. At least four independent backend lock waiters were observed while the account row was deliberately held. With 699 daily reservations, 30 contenders admitted exactly one and denied 29. Another test routed 24 actual server transport calls through real SQL, with six mocked provider sends and 18 quota denials. No provider was contacted.

Tests also cover UTC rollover preserving recent permits, rolling boundary expiry, hard-cap clamping, legacy-RPC bypass prevention, scope reserves, transaction rollback, injected SQL write failures, lock timeout, missing state, privilege denial, stale dispatch, failover exhaustion, private-bucket preflight and read-only verifiers. Historical 0001–0008 tests remain intact; separate suites apply/test **all migrations through 0009**. No existing security assertions were disabled.

**Failures encountered and resolved:** old tests expected seven/minute; tighter behavior was corrected in fixtures while retaining positive and negative throttle assertions. A new ticker fixture initially hit settlement-reserve first; its independent minute-limit scenario now starts with a clean disposable fixture. The local binary package had no `createdb` executable; the disposable DB was created through the local PostgreSQL client. The first real-PG attempt correctly failed because that test database did not yet exist.

**Lint limitation:** official upstream actionlint release download remained blocked. The old npm WASM build reported false `vars`-context errors. It was replaced, without suppressing errors, by exact-pinned **`@kjanat/actionlint` 1.17.0**, a documented actionlint fork packaged with native binaries and lockfile integrity. External shellcheck/pyflakes were not run; no separate application TypeScript/typecheck/lint configuration exists. No full historical secret audit is claimed: the checkout is shallow and the source scan is heuristic.

## 4. Workflow and security review

- Data cron remains UTC minutes **07 and 37**; training remains Sunday **03:17 UTC**. Both production workflows are default-branch only and automatic execution requires exact `NEXUS_SCHEDULE_ENABLED == 'true'`.
- Shared production concurrency prevents these two workflows overlapping. Manual modes stay preflight-only, ingest-only, outcomes-only, backfill-only. No scheduled backfill or Telegram sends.
- Added `.github/workflows/verify.yml`: offline tests on session-branch pushes/PRs, including a disposable PostgreSQL service and mandatory real concurrency tests. No production secrets or `pull_request_target`; permissions `contents: read`. Its clearly synthetic DB password belongs only to the disposable service.
- All actions are pinned to full SHAs; checkout credentials are not persisted. PostgreSQL service is version-pinned `postgres:17.6`, not image-digest-pinned; this is a remaining supply-chain limitation. Native lint packages are pinned/integrity-locked dev tools, not browser artifacts.
- Reviewed cumulative implementation changes and newly added files. No credential values, public model bucket, destructive production SQL, active-model promotion, budget bypass or forced push is included. Migration/test setup SQL is committed as reviewed preparation, not applied to production.
- `0008_read_only.sql` was updated to demand **stricter** service-role quota privileges after 0009; both 0008 and 0009 read-only verifiers pass locally. Do not restore broad old grants to make a verifier green.

## 5. Authorized hosted inspection: verified vs unknown

**Verified by current read-only GitHub responses:** default branch `main`; caller repository permissions include `push: true`; open PR list empty at inspection; main head `b953f6638024dc9bb641510996078303810e80aa`; session branch absent remotely before push. Existing Pages workflow is active; three recent reported runs had `success` conclusions. These are existing Pages runs, **not evidence for the new quota or scheduled workflows**.

**Inaccessible (HTTP 403):** repository secret-name listing, Actions repository variables (including schedule gate), Actions permission settings, and main branch protection. Secret presence and variable values are **unknown, not missing**. No secret values were requested or printed.

**Supabase:** connector reports unsupported; hosted Supabase/provider endpoints are outside this environment's allowed network. No production migration history, schema, RLS/grants/indexes, Storage bucket privacy, Auth configuration or service integration was verified. Existing objects must not be assumed missing. No hosted migration, bucket creation, credential change, production job, Telegram message or trade was executed.

## 6. Quota capacity and remaining risks

- Scheduled ingestion: 48 runs/day × at most six paid attempts = **288/day** theoretical maximum. This is below the existing **560/day** worker planning allowance and global **700/day** hard cap.
- At full scheduled ingestion, at most **412/day** nominal account capacity remains for browser, manual jobs and other workers. Scope headroom is not a guaranteed reservation against other scopes. Shared minute contention/failures can reduce throughput.
- `INGEST_PAIRS` remains a comma-separated list of active pair codes. Rough full refresh: `30 × ceil(pair_count/6)` minutes (1–6 pairs ≈30m; 7–12 ≈60m; 13–18 ≈90m), slower under retries/deferral. Default 360 one-minute candles cover approximately six hours only if provided gap-free.
- **All account consumers must use this same database and upgraded guard.** Direct external key usage, other Supabase projects, old clients with delayed sends, or privileged database owners are outside this guarantee. Inventory all deployments/keys and reconcile actual provider usage before cutover. No claim is made to control traffic from an unknown external application.
- A DB/RPC delay ≥1 second fails closed and may burn a reservation without sending. Verify hosted latency before approving use; never silently relax this to avoid failures. Provider receipt timestamps/network delays and real plan semantics still require hosted evidence.
- Browser-recorded predictions remain a data dependency. Anonymous provenance is not proof of authenticity; shadow candidates can still be poisoned by untrusted recorded votes. Existing non-atomic legacy model rollback/promotion needs a separately reviewed transactional mechanism.
- A 200-row settlement batch and many pairs/backlog can exceed desired freshness; `verified` with `stale > 0` proves readback, not a healthy current feed. Weekend/holiday context matters. Shadow trainer may reject invalid old checksums, overlapping priors or insufficient eligible history; it does not promote automatically.

## 7. Approval-gated deployment and phone procedure

1. Review this branch, cumulative diff and `docs/PR_DRAFT.md`. Push only the session branch, normally, if authorized/access permits. **Opening the PR requires separate approval**; merging requires another explicit approval. No auto-merge.
2. Phone browser: repository Settings → Secrets and variables → Actions. Inspect existing **names**, not screenshots/values: required `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TWELVEDATA_KEYS`; optional `INGEST_PAIRS`. Add/change credentials only after separate approval. Keep `NEXUS_SCHEDULE_ENABLED` absent/not exactly `true`; its hosted state is currently unknown. If already true, approve disabling it **before merging workflows**.
3. Supabase mobile browser: confirm project identity; inspect migration history for 0001–0009. SQL-editor installs may lack a ledger. Use `supabase/verify/deployment_read_only.sql` for schema/policies/constraints/indexes/Storage/candle/outcome/budget queries, plus `0008_read_only.sql`. Inspect Storage `models`: it must be **private** with reviewed policies. Do not create missing objects or apply all migrations blindly.
4. **Before migration 0009:** obtain explicit approval for the specific target project, migration, expected downtime and rollback plan. Stop all provider consumers (API relay paid routes, worker loops, manual jobs and scheduled jobs), inventory every account key/user, allow existing provider requests to drain, and back up relevant schema/privileges/counter snapshots. Read-only inspection is allowed; applying migration is not authorized by this implementation task.
5. After separately approved application, run `0008_read_only.sql` and `0009_read_only.sql`; compare actual function definitions to the committed migration. Check the singleton, RLS, grants, constraints, legacy wrappers, version and quarantine. Do **not** clear counters: wait until both the next UTC day and 61-second quarantine have passed. Only upgrade code, not resume traffic, during quarantine. New server code on an unupgraded DB deliberately fails closed.
6. Verify an isolated staging deployment first. Run the disposable concurrency tests in a development/CI environment; never point the destructive test harness at production. Then, with separately approved hosted tests, measure RPC latency, prove all clients use the same guard, verify provider account counters and private Storage/model readback. No fabricated predictions/outcomes.
7. Phone browser: Actions → **NEXUS data jobs** → Run workflow → `main` → **preflight-only**. Native app may require browser fallback. Verify the actual summary scope `schema-private-bucket-and-shared-quota-contract`, `verdict: verified`, and understand `productionReady: false`. A green run alone does not prove cutover or live behavior.
8. With explicit approval for paid/provider and production DB writes, run **ingest-only**, then **outcomes-only**. Inspect verified/stale/budget-deferred and due/evaluated/invalid/skipped counts; use read-only candle, outcome, duplicate and account-counter queries. Legitimate quota/no-prediction deferral is not proof of ingestion/settlement. Browser absence legitimately yields no predictions; do not manufacture results.
9. Backfill remains separately approved, **manual-only**, capped at six attempts per invocation. Do not run `once`/`loop` as a testing shortcut: they include other operational jobs and Telegram retries.
10. Only after ALL hosted gates pass, request explicit approval to set `NEXUS_SCHEDULE_ENABLED=true`. This enables **both** data scheduling and weekly shadow training. Observe the first two scheduled runs and the next weekly run, including real summaries/counters/freshness. Active-model promotion is not included.

Phone work: review/approve PRs, configure settings with approval, inspect Supabase, run read-only SQL, dispatch/cancel workflows and inspect summaries. Development environment: code review/tests, concurrency/latency testing, migration design, model promotion/rollback development. Phone UI checks do not replace engineering tests.

## 8. Rollback, monitoring and completion boundary

- With approval, set the schedule variable to anything except exact `true` (or remove it), cancel queued/running workflows, and stop independent paid worker/relay traffic. Removing the variable alone does not stop already running or external consumers.
- **Keep migration 0009 and its restrictive grants/wrappers in place during application rollback.** Never restore 0007/0008 reservation bodies, drop the shared table, delete/reset counters, refund ambiguous reservations or weaken constraints to regain capacity. If compatibility fails, keep paid traffic disabled and prepare a reviewed forward fix. Any database rollback requires its own approved plan and maintenance window.
- Revert code only through reviewed commits/PRs, not force-push or data resets. A previously pushed review branch can be corrected with a normal follow-up commit; no default-branch change is implied by pushing it.
- Retain model/outcome/history records. Restore a previously validated model only through a separately approved atomic registry swap after checksum/provenance/Storage verification; legacy two-step rollback is not an approved atomic procedure. Browser users explicitly reapply a valid model; server rollback alone does not undo local merged weights.
- Monitor shared `usage_day`, `daily_calls`, recent reservation count, `blocked_until`, and provider actual usage; compare secondary scope counters. Track guard-unavailable, expired permits, lock/storage/checksum failures, stale candles, pending/invalid outcomes and trainer rows left `running`. Any duplicate settlement or public bucket is a stop condition.
- Reservations, including failed requests and migration quarantine, are not a claim of actual account consumption or profitability. Never publish private tokens, prediction payloads or signed URLs in diagnostics.

**Completed:** preserved inherited work, shared quota implementation, real/offline concurrency and failure tests, regression/security scans, public build, workflow validation, read-only GitHub inspection, migration/verifier/runbook/PR preparation.

**Verified GitHub CI (not production):** offline verification, including real disposable PostgreSQL, completed successfully at `31fc256`. Non-failing runner warnings: pinned checkout/setup actions still declare Node 20 and GitHub ran them under Node 24; `ubuntu-latest` is scheduled to change images. Review action runtime/runner upgrades before longer-term activation. No errors were suppressed.

**Unverified/blocked:** hosted migration application and all-consumer cutover, real provider latency/account behavior, Supabase schema/policies/private Storage, secret/schedule/protection configuration and production data/training workflow executions. PR opening/merge, production settings/resources, activation, model swaps and live messaging/trading remain approval-gated. No production behavior was certified by local tests.


## 9. Continuation revalidation and redirect hardening (2026-10-15)

The current continuation started clean at `9f2539f`, with all four previous commits present and local/remote HEAD identical. No duplicate quota migration or replacement engine was added. Read-only GitHub inspection confirmed [run 38709558742](https://github.com/zenosx77/Nexus/actions/runs/38709558742) succeeded at that exact commit; no open PR exists. Existing Pages and offline-verification workflows were listed active. Secret/variable/Actions-settings/branch-protection metadata still returned HTTP 403. Supabase connector remained unsupported; hosted migration, private Storage and production behavior remain unverified.

Review found a transport-level quota gap: native `fetch` followed HTTP redirects implicitly. Provider requests now use `redirect: 'error'`, including free `api_usage` lookups so a free request cannot redirect into a paid endpoint. Any explicit key failover still requires its own reservation. Regression coverage uses native fetch against a local-only HTTP fixture for 301/302/303/307/308 across both scopes, verifies one reservation per explicit attempt, zero redirected requests, and no invented usage figures. The regression failed before the fix (exit 1: missing expected rejection) and passed afterward. The first extended test expected an HTTP-error message instead of the existing network-error result; its assertion was corrected to require null counters and the actual redacted network-error response. No existing test was weakened.

Fresh final execution: `npm test` exit **0** (84 server, 35 trainer, 25 security/migration, 2 workflow, 13 PGlite quota tests, browser smoke, public build/scan, source scan and actionlint); real PostgreSQL 17.6 suite **17 passed**, exit **0**. Both npm audits exit **0**, no vulnerabilities. Four YAML files, 42 JavaScript syntax checks, two Python compile checks and cumulative Git whitespace checks passed. Missing-config preflight still exits **1** as expected. No tests skipped; external shellcheck/pyflakes and hosted integrations were not executed. The disposable PostgreSQL server uses only a local Unix socket and is stopped after testing.

The initial follow-up changed only the provider redirect policy, its regression test and these two review documents. Subsequent CI diagnosis added a supplemental PostgreSQL failure reporter and corrected the concurrency test observer described below. Migration 0009, hard quota limits, schedule gates, shadow training, engines, weight merging, canonical model validation, mirroring, Telegram behavior, outcomes and manual-only backfill are unchanged. Redirecting provider responses now fail closed; investigate the canonical provider URL rather than re-enable automatic redirects. Existing conservative quota/cutover rollback instructions above remain mandatory.

The follow-up is eligible for a normal, authorized session-branch push after checks. Its exact commit, remote confirmation and any new GitHub CI outcome are reported by the final execution response; no production or PR operation is implied.


### GitHub failure investigation and test-harness correction

Follow-up commit `94f7d4f` was pushed normally and confirmed remotely. [Run 38710481443](https://github.com/zenosx77/Nexus/actions/runs/38710481443) passed `npm test` but failed the real-PostgreSQL step (exit 1); the later Git check was skipped by GitHub. Detailed log downloads redirect to a host blocked in this environment, so their contents could not be fetched. Commit `599ab9c` added a supplemental Node test reporter that publishes actual disposable-suite assertion failures as escaped GitHub annotations while preserving TAP and the original exit status.

[Run 38710757468](https://github.com/zenosx77/Nexus/actions/runs/38710757468) exposed the exact failure through the authorized API: the concurrency observer saw zero blocked connections instead of at least four. The lock-holding transaction had cached an initial empty `pg_stat_activity` snapshot. The regression was reproduced locally by deliberately reading that empty snapshot before starting contenders (exit 1). Observation now uses a separate autocommit connection, so each poll sees fresh activity without releasing the quota row lock. The test still asserts at least four independent lock waiters, exactly six admitted requests and exactly one winner for the final daily credit. Outstanding contenders are always drained before the next fixture, including after a monitoring assertion failure. No production quota code, test assertion threshold or timing/credit guarantee was relaxed.

After this correction, fresh `npm test` and real PostgreSQL tests both exit 0 with the totals above; source scan checks 82 text files, and syntax checks cover 42 JavaScript files. Reporter escaping was checked with a synthetic failure; production jobs never use this reporter. The final execution response records the corrected follow-up commit and its GitHub CI outcome rather than assuming a successful push or run.


## 10. Restart, crash and accounting verification (2026-10-15)

The latest workspace again initially exposed only `b953f66` locally, with the existing implementation as restored file changes. The named `87d3003` / `78a2996` objects were absent. Authorized fetch recovered the session branch at `1ca14f18a8afa368ffd6f1311db2ff673066b513`. A full staged-tree comparison against that remote commit returned **no differences**; the local branch pointer was advanced using `git reset --soft FETCH_HEAD` after confirming ancestry and tree equality. This preserved all file contents and the actual published commit history; no remote history rewrite or duplicate implementation commit occurred. GitHub independently confirmed [run 38711173037](https://github.com/zenosx77/Nexus/actions/runs/38711173037) succeeded at that commit.

The shared quota design was already present and is unchanged. This follow-up adds:

- A disposable child-worker fixture with a loopback/Unix-socket-only test DB allowlist and fake provider transport. Each child uses a fresh process and PostgreSQL connection, not a cleared in-memory mock counter.
- Six sequential process restarts each reserve/send exactly once; a seventh process is denied with the account still at six. Scope counters sum to six rather than granting extra account capacity.
- A worker killed immediately after a committed reservation leaves that charge intact. A simulated lost RPC reply consumes exactly one reservation, sends no provider call, and is not automatically retried. A new process cannot erase either charge.
- Separate processes exercising provider HTTP failover and network retry each reserve exactly once per attempted provider call (four attempts, four account charges).
- Twelve simultaneous worker/browser processes receive exactly six total grants and six quota denials. Every dispatched fake call is backed by a grant. Any admitted permit expiring under heavy load is allowed only as an explicitly checked `guard-unavailable`/expired result, never as a seventh grant; the existing strict six-admission SQL/connection tests remain unchanged.
- An installed-Supabase-SDK regression verifies quota RPCs are POSTs and execute only once on success, HTTP 503 and network/lost-reply failures in both scopes. This checks the real dependency's retry behavior, not only a mock `.rpc()` method.

**Accounting semantics:** the ledger counts durable reservations before paid dispatch, not billing receipts. A successful ordinary attempt is charged once globally and once in its secondary scope; do not add the global and scope counters together. Each explicit provider retry/failover is a new attempted call and requires a new reservation. Denied requests spend no credit. A crash, lost reply, or expired dispatch permit can leave a reservation without an actual provider call: conservative underuse is deliberate and must not be called actual consumption or silently refunded. Exactly-once provider billing across a database/HTTP failure boundary is not claimed. All account consumers must use this guard; third-party direct-key traffic remains outside its guarantee.

**Fresh evidence:** root and server clean dependency installs exit 0; `npm test` passes browser smoke, **85 server**, **35 trainer**, **25 security/migration**, **2 workflow**, **13 PGlite** tests, public build/scan, source scan and the already-pinned Actionlint fork. The real PostgreSQL suite now reports **21 passed**, exit 0, with no skips/failures. Source scan covers **83 text files**; syntax checks cover **43 JavaScript** and **2 Python** files. All **4 workflow YAML** files parse. Both npm audits exit 0 with zero reported vulnerabilities. Git whitespace checks pass. PyYAML was initially absent and installed only in an ignored local venv. External shellcheck/pyflakes, a full historical secret scan, hosted Supabase/provider tests and production migrations were not executed.

**Access rechecked, not assumed:** repository metadata reports push permission; open-PR list is empty. Secret-name listing, repository variables, Actions permission settings and main branch protection still return **HTTP 403**. Supabase connector reports unsupported, and hosted Supabase/provider endpoints are outside available network access. Applied migrations, bucket existence/privacy and production pipeline behavior therefore remain unknown. No public Storage change, production settings edit, migration application, PR creation or schedule activation is authorized/performed by this work.

The previous quota calculations and rollback gates remain in force: scheduled ingestion ≤288/day, worker planning allowance 560/day, global hard ceiling 700/day. Keep migration 0009 and all counters/constraints during rollback; stop paid traffic on uncertainty, wait for legitimate reset/quarantine, and use an approved forward fix—never reset budgets or restore the independent RPCs. Updated tests do not alter the engines, trainer safeguards, model merge/validation, mirroring, Telegram, settlement, readbacks, backfill policy, or scheduled gates. This follow-up's exact commit, push result and CI result are recorded in the execution response after confirmation.
