# NEXUS Liquid Glass redesign — audit, feature-preservation checklist, API map

> NEXUS — **Predict. Learn. Grow.** · Created by Vinayyyy
>
> This document records the audit that preceded the redesign, the checklist that proves
> no existing feature was dropped, and the mapping from every existing API to the
> redesigned UI. See [MODULES.md](MODULES.md) for per-module reference.

## 1 · Audit of the pre-redesign application (commit `21fba75`)

| Area | What existed | Where |
| --- | --- | --- |
| Shell | Single static `index.html` (no bundler, no CDN), self-hosted Inter, CSP, 11 tabbed pages, glassmorphic cards | `index.html` |
| Prediction engine | 26 strategies in 4 families, 6 agents (TREND/MOMENTUM/PATTERN/STRUCTURE/STRATEGY/VOLATILITY), regime detection, weight fusion, validation filter, NONSTOP last-resort grade | `index.html` (`STRATS`, `fuse`, `validateSetup`, `runScan`) |
| Settlement | Feed-clock-keyed targets, revision-window-safe confirmation, ties = PUSH, single settlement path for every stream | `resolveSignal`, `candleOutcome`, `settleAll`, `settlementFetches` |
| Streams | LIVE scan, SESSION engine, VIP shots (10 min), PUBLIC (1 min), PREMIUM LIST (10-min study → 40–60 min slots → RESULT), BOT stream | `sx*`, `vx*`, `pub*`, `prem*`, `bot*` |
| Self-learning | Per-strategy/per-regime memory, quick backtest, deep 5,000-bar walk-forward training, weight blending, production gate, deep backtest report | `mem`, `train`, `deepTrainSeries`, `productionGate`, `backtestSeries` |
| Risk / paper | Paper account, payout/friction, stake sizing, daily stop, max trades, cooldown, max open, circuit breaker, CSV history export | `paper`, `risk`, `riskAdmit`, `paperResolve`, `exportCSV` |
| Telegram | Server-side token/destinations, 4 channel aliases with MAIN fallback, per-event sticker bank (9 roles, dedupe), `/setformat` format engine, protect content, command listener, test message | `tg*`, `STK_ROLES`, `fmt*`, `tgListenLoop` |
| Data / quota | Relay-only provider access, per-key `api_usage` (0 credits), local secondary caps under a shared server ceiling (700/day, 6/min across all clients), 20 % settlement reserve, feed diagnostics | `jget`, `budget*`, `apiUsageCheck`, `verifyFeeds` |
| Cloud | Supabase anon-only REST mirror (`predictions`, delivery status view, freshness, ingestion health, risk snapshots), SHA-256-verified cloud model apply, canonical JSON identical to the Python trainer | `sb*` |
| Ops | Worker/ingestion run log, retention, RLS/grants, credit-budget RPC, quota migration 0009 | `server/`, `supabase/migrations/` |
| Polish | Command palette (Ctrl/⌘K), toasts, ripples, online pill, back-to-top, reduced motion, local-only art hook | `initProductPolish`, `loadLocalArt` |

**Nothing in the pre-redesign application was removed.**

## 2 · Feature-preservation checklist

| # | Feature | Status after redesign | Evidence |
| --- | --- | --- | --- |
| 1 | 26 strategies + 6 agents + regime + fusion | preserved, logic untouched | `tests/smoke.cjs` §5, §9, §16 |
| 2 | Scan controls (pairs, timeframes, lead, M5, AUTO, NONSTOP, blackout) | preserved on Signals | §10, §16, §20 |
| 3 | Feed-clock repair + freshness/weekend gates | preserved | §8, §18 |
| 4 | Revision-safe settlement, ties = push | preserved | §11, §17 |
| 5 | M1 / M3 / LIST stream separation | preserved | §26 |
| 6 | SESSION engine + guard + outros | preserved | §30, §31 |
| 7 | VIP best-shot stream + honest grade | preserved | §23c |
| 8 | PUBLIC quality stream + privacy filter | preserved | §23b, §24 |
| 9 | PREMIUM LIST study → slots → RESULT | preserved | §22 |
| 10 | Sticker bank (9 roles, dedupe, unassigned never fires) | preserved | §14 |
| 11 | Format engine (`/setformat`, placeholders, markup) | preserved | §15 |
| 12 | Server-only secrets (provider keys, bot token, service role) | preserved | §6, §32 |
| 13 | Shared credit ceiling + reserve + per-minute caps | preserved | §21 |
| 14 | `api_usage` free check + provider-key aliasing | preserved | §6 |
| 15 | Production validation gate | preserved | §11b, §28 |
| 16 | Deep training / backtest / weight blending | preserved | §28 |
| 17 | Cloud mirror (anon only, idempotent, relay-managed delivery) | preserved | §32 |
| 18 | SHA-256 + canonical-JSON model verification | preserved | §32 |
| 19 | Paper account, risk limits, CSV export, history | preserved | §17, §27 |
| 20 | Command palette, toasts, reduced motion, online pill | preserved (extended) | §3, redesign tests |
| 21 | Local-art lockdown (never published, never fetched on Pages) | preserved | §25 |
| 22 | Legacy storage migration | preserved | §29 |
| 23 | Manual-only backfills, shadow-only training, no live orders | preserved | §27, §28, workflows tests |

## 3 · API → redesigned UI map

| Existing API / source | Consumed by (after redesign) |
| --- | --- |
| `/api/v1/health` | Overview summary + rail, Data · relay block, System health · relay row, `checkNexusRelay()` |
| `/api/v1/session` | Cloud connect, Telegram channel aliases, System health · session row, Settings · security |
| `/api/v1/market` `time_series 1min` | Signals scan + ticker, Markets · chart & analysis, `LOAD CANDLES`, settlement fetches |
| `/api/v1/market` `time_series 5min` | Signals · M5 confirmation (optional) |
| `/api/v1/market` `quote`/`price`/`exchange_rate` | Data · feed diagnostics only (unchanged, on demand) |
| `/api/v1/usage` | Data · API credit usage, System health · quota row |
| `/api/v1/telegram` | Session, VIP, List, Bot stream, Telegram tooling, System health · delivery row |
| Supabase `predictions` (insert) | Cloud sync · recording switch (silent no-op when offline) |
| Supabase `v_market_freshness`, `v_ingestion_health_public` | Cloud sync · market-data health, System health · worker/ingestion row |
| Supabase `v_deliveries_public` | Cloud sync · delivery log, System health · audit table |
| Supabase `model_versions` + Storage artifact | AI learning · model versions, Cloud sync · cloud model apply |
| Local stores (`nx_stats2`, `nx_hist`, `nx_paper`, `nx_openSigs`, `nx_siglog`) | Overview statistics, Performance page, Signal registry |
| Engine state (`cache`, `sigLog`, `budget`, `sx`, `vx`, `px`, `tg`, `deep`) | Overview, Markets, Signals, Performance, AI learning, System health |

**No new external endpoint was introduced by the redesign.**

## 4 · What the redesign added

* **Liquid Glass design system** — tokens (midnight `#04060d`, ocean blue, silver, restrained cyan `#3ad2ff`), layered translucent surfaces with real `backdrop-filter`, fine borders, sheen, inner highlight, soft depth; a fully tokenised **light theme** and **corsair theme** (aged-brass accent on abyssal navy); a **solid-background fallback** when blur is unavailable.
* **Original artwork** — inline vector ocean/harbour/horizon/current scenes tinted by theme tokens, used only as an ambient layer with a user-controlled intensity, so contrast is never reduced. No franchise assets, logos or characters.
* **Registry-driven navigation** — 15 sections in 5 groups, a desktop rail, a tab bar and a mobile bar all generated from `FEATURES`, so a new module is one registry entry.
* **New modules** — Markets (explorer, candlestick chart, pair analysis), System health (service matrix, staleness, audit), Settings (appearance, notifications, security, configuration catalogue), Branding studio (logo variants, favicon, app icon, loader, wallpaper, creator card).
* **Signal registry** — every emitted signal (live, session, VIP, public, list) becomes a durable record with an explicit state: *pending · settled win/loss/push · invalid · unavailable*, with search, filters, sorting and a detail drawer.
* **Charts** — dependency-free SVG candlesticks with recorded signal markers, outcome donut, paper equity curve and pair bars, all built only from real records.
* **Performance depth** — pair breakdown, timeframe breakdown and a settlement-integrity statement that separates pending from settled, and never counts an unconfirmed verdict as a win.
* **Overview widgets** — show, hide and reorder every card; layout persists per browser.
* **Accessibility and motion** — focus-visible rings, labelled controls, `aria-live` toasts, reduced-motion respect plus an in-app switch, and status communicated by text as well as colour.

## 5 · Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Browser regression + redesign suite | `npm run test:browser` | pass (single inline script, no jsdom/runtime errors, chaos pass clean) |
| Server unit/integration | `npm run test:server` | 105/105 pass |
| Trainer | `npm run test:trainer` | 35 pass |
| Security / migrations / public guard / config contract | `npm run test:security` | 25/25 pass |
| Public artifact guard | `npm run check:public` | pass |
| Workflow safety | `npm run test:workflows` | 3/3 pass |
| Shared quota | `npm run test:quota` | 13/13 pass |
| Secret scan | `npm run check:secrets` | pass |
| Workflow lint | `npm run lint:workflows` | 4 workflows linted |
| Edge relay (Deno) | `npm run test:edge` | 40 passed / 0 failed |
| PostgreSQL quota suite | `npm run test:postgres` | **not executed here** — requires a live PostgreSQL instance (runs in CI `.github/workflows/verify.yml`) |

Deployment is unchanged: the Pages workflow publishes `index.html` + fonts after
`tools/check-public.cjs`. **No deployment was performed from this checkout, and no
migration was applied.**
