# Supabase schema — NEXUS

Versioned SQL migrations are **not automatically applied** by npm, server startup or Pages. Hosted migration **0008 is unconfirmed**. Follow [the staging-first deployment runbook](../docs/DEPLOYMENT.md) before any live operation. Do not link to production or run an unreviewed loop over historic migrations.

## Migrations

| File | Contents |
|---|---|
| `0001_core.sql` | `currency_pairs`, `market_candles`, `market_features`, freshness view, 10 seed pairs, pgcrypto |
| `0002_predictions.sql` | Shared predictions, canonical outcomes, revision audit and accuracy view |
| `0003_ml.sql` | Model registry, training runs and prediction model FK |
| `0004_ops.sql` | Risk, ingestion, Telegram, settings, job locks/RPCs and alerts |
| `0005_rls.sql` | Initial RLS policies; **its public operational reads/delivery inserts are superseded by 0008** |
| `0006_retention.sql` | Worker retention/prune RPCs |
| `0007_twelvedata_credit_budget.sql` | Atomic persistent worker credit reservations (700/day, 6/min defaults in code) |
| `0008_cloud_security_and_browser_budget.sql` | Separate browser credit reservations (700/day, 7/min), safe ingestion view, `server_managed` delivery provenance, public operational-table/RPC privilege hardening and removal of browser delivery inserts |

Apply 0001–0008 in order **only to an explicitly approved staging target** using a reviewed SQL Editor or supported CLI workflow. Record target/revision and backup first. Existing projects need a schema/ledger comparison, not indiscriminate reapplication. The repository fixes quoting of the existing reserved identifier `"window"` in 0004/0006 for fresh PostgreSQL installs; it does not rename the column and is not a reason to rewrite a hosted ledger.

After 0008, anon/authenticated retain intended shared reads and browser prediction inserts. They cannot insert deliveries, read raw operational payloads/destinations or execute maintenance/budget/job-lock RPCs. Predictions are not owner-private or trusted evidence. Historical deliveries default to `server_managed=false` and are not retried; do not mark them server-managed merely to re-enable a queue.

## Verification

- `npm run test:security` from the repository root runs migrations with pgcrypto in disposable in-memory PGlite, simulated roles and broad initial grants. It tests privilege/RLS/budget behavior and the read-only verifier. No hosted project, SQL service, provider credits or credentials are used.
- `supabase/verify/0008_read_only.sql` performs schema, RLS, view and privilege assertions in a **read-only transaction**. A future authorized operator should run it as the staging database administrator and retain sanitized evidence. It reserves no credits and acquires no job locks.
- Inspect actual migration history if maintained; SQL Editor applications may not appear in a CLI ledger. Passing the schema verifier establishes the checked properties, not the history, Auth settings, PostgREST permissions under real JWTs or multi-connection concurrency.
- Test real staging anon/authenticated access and concurrent RPC reservations separately, without external provider calls. Never tamper with production counter tables for verification.

## Optional private Storage

A private bucket named `models` is required only for enabled archive/trainer workflows. Create it only under the appropriate staging approval and verify it is not publicly readable. The trainer uploads artifacts/datasets with a server credential. The browser uses the verified small `artifact_payload` mirror from `model_versions`, not public Storage access.

## Retention and rollback

The worker runs housekeeping during `once`/startup and then daily. `RETENTION_DAYS` controls its candle retention argument; `ARCHIVE_BEFORE_PRUNE` controls archival, **not whether pruning runs**. Defaults are 180 days and archival false. Other operational pruning details are defined in 0006 and `server/src/housekeeping.js`.

Do not use `once` as a safe smoke test. See the runbook's single-pair bounded ingestion procedure. On rollback, stop the worker first, preserve security restrictions and budget history, and restore only a compatible approved application revision. Do not revoke 0008 protections to accommodate an old browser/worker. Production migration/rollback is a separate reviewed operation.
