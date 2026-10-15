# Supabase schema — NEXUS

Versioned SQL migrations. Apply in order with the Supabase CLI **or** paste each file into the Supabase Dashboard → SQL Editor (they are idempotent-safe to re-run in a fresh project, and `on conflict do nothing` where data exists).

```bash
# option A — Supabase CLI (recommended, keeps history)
supabase link --project-ref <your-project-ref>
for f in supabase/migrations/*.sql; do supabase db execute --file "$f"; done

# option B — dashboard
# Supabase Dashboard → SQL Editor → run each file in numeric order
```

## Migrations

| File | Contents |
|---|---|
| `0001_core.sql` | `currency_pairs`, `market_candles`, `market_features`, freshness view, 10 seed pairs |
| `0002_predictions.sql` | `predictions`, `trade_outcomes`, `trade_outcome_revisions` (audit trigger), accuracy view |
| `0003_ml.sql` | `model_versions` (registry + one-deployed constraint), `training_runs`, late FK from predictions |
| `0004_ops.sql` | `risk_snapshots`, `ingestion_runs`, `telegram_deliveries`, `system_settings` (seeded), `job_locks` (+ `try_job_lock`/`release_job_lock` RPCs), `alert_log` |
| `0005_rls.sql` | Row Level Security: anon can INSERT browser predictions + completed delivery records and SELECT monitoring data; **nothing else**. All other writes require the service-role key |
| `0006_retention.sql` | `prune_market_candles(days)`, `prune_operational_logs(days)`, `prune_risk_snapshots()`, `prune_job_locks()` |
| `0007_twelvedata_credit_budget.sql` | Persistent, atomic daily/minute Twelve Data request reservations for the server worker (service-role only) |

## Storage bucket (private model artifacts)

Create one **private** bucket named `models` (Dashboard → Storage, or CLI):

```bash
supabase storage buckets create models --public=false
```

The Python trainer uploads artifacts to `models/artifacts/<model-id>.json` and dataset snapshots to `models/datasets/<run-id>.jsonl` using the service-role key. Artifacts are **never public**; the dashboard consumes the small verified `artifact_payload` mirror on `model_versions` (checksum-checked against `artifact_sha256`).

## Retention

- Default: 180 days of 1-minute candles (~1.3M rows/month at 30 pairs — fine on the default Postgres).
- The worker's `housekeeping` job calls `prune_market_candles` / `prune_operational_logs` / `prune_risk_snapshots` weekly (configurable via `system_settings.retention.candles_days`).
- Set `ARCHIVE_BEFORE_PRUNE=true` on the worker to export candles to Storage (`models/archive/…jsonl.gz`) before pruning — see `server/README.md`.

## Verification after applying

```sql
select code, is_active from currency_pairs order by code;                 -- 10 rows
select relname, relrowsecurity from pg_class
 where relname in ('predictions','market_candles','model_versions');      -- relrowsecurity = true
select try_job_lock('smoke-test','manual',60);                            -- true
select release_job_lock('smoke-test','manual');
```
