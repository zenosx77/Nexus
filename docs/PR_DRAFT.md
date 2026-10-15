# Draft PR: Verify NEXUS scheduled data jobs and shadow trainer integrity

Base: `main` · Head: `arena/262a1d23-nexus` · **Not opened; separate approval required.**

## Summary
- Add gated half-hour data jobs and weekly shadow-only training, with pinned actions and shared concurrency.
- Correct uploaded artifact/browser checksum compatibility; reject malformed candidates before any browser weight changes; verify Storage and registry readbacks.
- Filter eligible decisive records, purge evaluation boundary leakage and reject overlapping deployed priors.
- Add six-attempt job caps, truthful postconditions/redacted summaries, 90-minute settlement grace, correct horizon lookup and exact candle loading.
- Keep backfill manual, browser predictions as the data dependency, and Telegram/engine/weight blending behavior intact.

## Tests
`npm test`: browser smoke passes; 78 server tests; 35 trainer tests; 25 security/migration tests; 1 workflow contract; public artifact and source secret scans. `git diff --check` and YAML parsing pass. Missing-config preflight fails correctly with exit 1. actionlint unavailable; no hosted integrations executed. See `docs/DEPLOYMENT_VERIFICATION.md` for full results and limitations.

## Security / deployment prerequisites
No secrets added; no production changes. Migrations 0001–0008 tested in disposable PostgreSQL only. Production secret/variable metadata inaccessible (403), Supabase state unverified. Confirm schedule gate is disabled before merging. **Activation blocked pending a shared-account quota design**: existing browser/worker counters are independent and can exceed the real account total. Review anonymous-source provenance and transactional promotion/rollback before relying on model metrics.

## Rollback
Disable schedule variable and cancel pending/running jobs with approval. Use reviewed revert PRs, never destructive resets. Preserve previous validated models/history; production restoration requires a separately approved atomic registry swap, not the legacy nontransactional CLI. Never reset budget counters or remove constraints to recover.

## Approval boundaries
No push, PR opening, merge, migration, secrets change, schedule activation, active-model change, paid manual run or Telegram send is included in local implementation authorization.
