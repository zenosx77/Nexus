# Draft PR: NEXUS shared account quotas and verified shadow/data jobs

Base: `main` · Head: `arena/262a1d23-nexus` · **PR NOT opened; separate approval required.**

## Summary
- Preserve restored trainer/browser canonical validation, eligible-outcome filtering, purged evaluation boundaries and shadow-only training.
- Add default-branch gated half-hour data jobs and weekly shadow training; retain manual backfill and browser prediction dependency, with no Telegram/engine/weight-merge changes.
- Add migration **0009**: one account-row lock and atomic transaction for **700 paid reservations/UTC day and six per rolling minute across all scopes/keys/retries**; legacy RPCs route through the same guard.
- Reject automatic HTTP redirects for paid requests and free usage lookups, preventing unreserved redirected requests; native-fetch/local-server regression covers both scopes, all redirect status codes and bounded key failovers.
- Fail closed on missing/version-mismatched/slow/malformed quota responses. Conservative 61-second rolling window plus ≤1000ms dispatch expiry; no refunds after ambiguous commits.
- Preserve stricter secondary scope limits; deny direct service-role quota mutations. Installation-day quarantine prevents inventing headroom from unknown old traffic.
- Fix per-job in-process reservation race and inherited preflight `market_features` table typo.
- Verify persistence across actual worker-process restarts/crashes, lost RPC replies and 12 concurrent worker/browser processes; test exact per-attempt retry/failover accounting through real SQL and installed SDK retry behavior.
- Add offline-only verification CI with real PostgreSQL concurrency tests, pinned actions, read-only permissions and no production secrets.

## Commits / state
`8cbbb61` preserves prior files restored without the previously reported commit objects; `1c23103` implements shared quotas/tests. `31fc256` records deployment/cutover documentation. Normal branch push was confirmed, and [offline verification run 38709335739](https://github.com/zenosx77/Nexus/actions/runs/38709335739) succeeded at `31fc256`; `9f2539f` records that evidence and [run 38709558742](https://github.com/zenosx77/Nexus/actions/runs/38709558742) also succeeded at that commit. Commit `94f7d4f` closes the HTTP redirect gap without duplicating migration 0009. Its CI passed `npm test` but failed PostgreSQL contention observation. `599ab9c` added readable failure annotations; a subsequent fix observes locks through a separate autocommit connection to avoid PostgreSQL statistics snapshot caching. The same failure was reproduced locally before the fix, and all admission/lock assertions remain intact. No history rewrite, forced push, PR creation or merge is part of this work.

## Tests
Clean installs and `npm test` exit 0: browser smoke; **85 server**, **35 trainer**, **25 security/migration**, **2 workflow**, **13 PGlite quota** tests; public artifact and source secret scans; actionlint. Separate real PostgreSQL 17.6 suite: **21 passed**. Forty simultaneous calls admit six; 30 competitors for the last daily permit admit one. YAML (4), JS syntax (43), Python compile (2), `git diff --check` and both npm audits pass; audits report 0 vulnerabilities. Missing-config preflight correctly exits 1. Tests use fake provider/Bot transports, not production traffic.

Actionlint uses exact-pinned `@kjanat/actionlint` 1.17.0 fork because official binary access is blocked; shellcheck/pyflakes not run. PostgreSQL CI service is version-pinned, not digest-pinned. Hosted CI emitted non-failing Node 20 action-runtime and upcoming runner-image warnings; no production job was run. The two failed follow-up CI runs and the reproduced statistics-snapshot failure are explicitly recorded, not hidden by a rerun. Full evidence and failed intermediate checks: `docs/DEPLOYMENT_VERIFICATION.md`.

## Deployment / security gates
**DO NOT ACTIVATE FROM THIS PR ALONE.** Migration 0009 is prepared, not applied to production. GitHub confirms push permission and existing Pages metadata, but secret/variable/protection/Actions-settings inspection returns 403. Hosted Supabase is inaccessible; applied migrations, policies and private `models` bucket remain unknown.

Before merge, confirm schedule gate is disabled. Before paid traffic, obtain separate migration approval, stop/drain **all** account consumers, apply reviewed migration, upgrade every client, wait out initial UTC-day/61s quarantine, run read-only 0008/0009 checks and hosted staging/provider tests. Every account consumer must use the same database; external key users cannot be controlled by this guard. Only explicit approval after all gates pass may enable schedules.

## Rollback
Disable schedules, cancel runs and stop external consumers with approval. **Retain 0009 counters/guards/grants while reverting application code. Never reset budgets, refund uncertain requests, drop the singleton, or restore independent 0007/0008 RPCs.** If incompatibility occurs, keep paid routes disabled and prepare a reviewed forward fix. Preserve historical outcomes/models; model restoration requires a separately approved atomic swap, not the legacy nontransactional CLI.


## Latest continuation evidence
The restored workspace matched remote `1ca14f1` exactly; its published history was recovered locally without altering files or force-pushing. That commit's GitHub run 38711173037 succeeded. The latest follow-up adds only restart/crash/accounting regression coverage and documentation; no duplicate quota migration or production behavior change. Local full suite and all 21 real-PostgreSQL tests pass. Normal sends are charged once; uncertain committed reservations are intentionally retained without dispatch or automatic reservation retry. Do not equate these conservative charges with provider billing or promise exactly-once billing across network failures. All earlier hosted verification and explicit production approval gates remain blocked.
