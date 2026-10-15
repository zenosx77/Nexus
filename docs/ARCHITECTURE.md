# NEXUS × Supabase — Architecture Report & Integration Plan

**Date:** 2026-10-14 · **Repo state inspected:** `arena/9af041a8-nexus` @ v5.1 Meridian
**Scope:** inspect the existing system, then integrate Supabase as the persistence + monitoring layer without replacing working logic.

---

## 1. Current architecture (inspection findings)

| Layer | Today | Notes |
|---|---|---|
| **App shell** | One self-contained `index.html` (~4,100 lines) — HTML + CSS + one inline script. No build step, no CDN, strict CSP (`connect-src` = `api.twelvedata.com` + `api.telegram.org`). Optional gitignored `keys.js` for private credentials. | Deployed via GitHub Pages (`public/` copy + credential guard `tools/check-public.cjs`). |
| **Prediction engine** | 26 strategies + 6 agents → fusion → validation → risk gates → `emitSignal()`. Runs **fully in the browser**. Signal targets the next candle open keyed to the **feed clock** (`nextTargetFromFeed`). | Pure functions with a shared context object (`makeCtx` → `x.e9/x.rs/x.bb/…`). |
| **Streams** | 4 Telegram channels (MAIN / PUBLIC / VIP / LIST) driven from the browser via `tgCall()` → Bot API. Public stream = 1 quality signal/min before the open; VIP = best shot every 10 min. | Delivery authorization is explicit (`tg.auth`); token changes revoke it. |
| **Self-learning** | In-browser walk-forward training (`train`, `deepTrainSeries`) producing per-strategy/per-regime win-rate weights persisted to `localStorage` (`nx_deep`, `nx_mem`, `nx_memR`). `finalWeights()` blends live + deep + regime memory. | This is the interface a promoted cloud model must feed — **weights, not logic**. |
| **Outcome settlement** | `candleOutcome()` + `resolveSignal()` settle from confirmed candle closes (fast settle). Stats in `localStorage` (`nx_stats2`, `nx_hist`), capped at 200 rows, single-browser only. | **Key gap this integration fixes:** outcomes/accuracy are not durable, not multi-device, not queryable. |
| **Market data** | Twelve Data `time_series` (1min candles), 10 rotating key slots, quota cooldown, budget throttling. Cache is per-page-load. | No server-side history — every reload re-fetches; no gap accounting. |
| **Storage** | 100% browser `localStorage`. | No retention/backup story. |

**Integration risks identified**
1. CSP must allow the Supabase project domain, or every cloud call fails silently.
2. The public repo deploys to Pages — **no secret may ever reach `index.html`** (service-role key, bot token for retries, market-data keys must stay server-side).
3. The app must keep working with **no Supabase configuration** (backward compatibility, public demo).
4. Browser predictions must be recorded **idempotently** (page reloads, duplicate scans).
5. The self-learning artifact must stay **compatible with `finalWeights()`** so promotion is a weight merge, never a logic swap.

---

## 2. Target architecture

```
┌──────────────────────── browser (existing app, unchanged engine) ───────────────────────┐
│  prediction engine (26 strats + agents)  →  emitSignal() ──┐                             │
│  telegram send (existing tgCall)          →  tgSendTo() ──┤─► SB mirror (fetch/REST,     │
│  local paper stats (unchanged)                                  │   anon key only, RLS-    │
└─────────────────────────────────────────────────────────────────┘   guarded, optional)   │
                                                                     │
                                        https://<project>.supabase.co│
┌─────────────────────────────────────────────────────────────────────▼──────────────────┐
│  Supabase PostgreSQL — 10 spec tables + system_settings/job_locks/alert_log              │
│  Supabase Storage (private bucket "models") — training artifacts + dataset snapshots     │
│  RLS: anon = INSERT predictions/deliveries only; SELECT monitoring; service = full       │
└───────────────▲─────────────────────────▲──────────────────────────▲────────────────────┘
                │                         │                          │
┌───────────────┴────────┐  ┌─────────────┴───────────┐  ┌───────────┴──────────────┐
│ Node worker (server/)  │  │ Python trainer (trainer/)│  │ Dashboard panels        │
│ • ingest candles       │  │ • scheduled training     │  │ (new CLOUD page + chips │
│ • validate/dedupe/gaps │  │ • walk-forward + holdout │  │  on existing pages;     │
│ • evaluate outcomes    │  │ • shadow-mode candidates │  │  read-only, polling)    │
│ • risk snapshots       │  │ • gated promotion +      │  └─────────────────────────┘
│ • telegram retries     │  │   rollback               │
│ • alerts + retention   │  │ • artifacts → Storage    │
└────────────────────────┘  └─────────────────────────┘
```

**Division of responsibility (principle: never move working logic)**
- The **browser remains the source of live predictions**. It *mirrors* each signal and each Telegram delivery into Supabase (anon key, insert-only, RLS-guarded, dedup key).
- The **Node worker** owns everything the browser cannot do reliably: server-side candle ingestion with gap/duplicate/stale detection, outcome evaluation from confirmed candles, rolling risk metrics, delivery retries, operational alerts, retention.
- The **Python trainer** owns model training (never in the browser / DB triggers / edge functions): reproducible datasets from point-in-time features, chronological walk-forward + holdout, shadow-mode replay against recorded production outcomes, gated promotion with checksum-verified artifacts and rollback.
- **Promoted models feed the existing engine as weights** — `model_versions.artifact_payload` (verified by `artifact_sha256`) maps onto the existing `deep[tf].strats[s].vwr/vtrades` interface consumed by `finalWeights()`. No logic swap, always reversible.

## 3. Implementation plan (executed in this change set)

| # | Step | Files |
|---|---|---|
| 1 | Architecture report (this file) | `docs/ARCHITECTURE.md` |
| 2 | Versioned SQL migrations: 10 spec tables + support tables, FKs, checks, indexes, triggers, views, RLS, retention functions, seed pairs | `supabase/migrations/0001…0006` |
| 3 | Node worker: config, db, ingestion, validation, features, outcome evaluator, risk monitor, telegram retry, alerts, scheduler with job locks | `server/**` |
| 4 | Python trainer: dataset builder (leakage-safe), walk-forward validation, promotion gates, artifact + checksum, shadow/rollback CLIs | `trainer/**` |
| 5 | Frontend: REST-only Supabase client (no CDN/library), prediction + delivery mirroring, CLOUD dashboard page, deployed-model apply, CSP update | `index.html` |
| 6 | Security: credential guard extended for service-role patterns, `.gitignore` for env files | `tools/check-public.cjs`, `.gitignore` |
| 7 | Tests: jsdom suite extensions + worker unit tests (`node --test`) + trainer unit tests (`unittest`) | `tests/smoke.cjs`, `server/test/*`, `trainer/test_trainer.py` |
| 8 | Setup docs: end-to-end Supabase setup, env vars, migrations, deployment | `SUPABASE_SETUP.md`, `README.md`, `keys.example.js`, `server/.env.example`, `trainer/.env.example` |

**Backward compatibility contract:** with no Supabase URL/anon key configured, the app behaves exactly as v5.1 (all local features intact). All migrations are additive. No existing localStorage key changes meaning. No existing engine function is removed.
