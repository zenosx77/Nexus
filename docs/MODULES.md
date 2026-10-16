# NEXUS modules — routes, APIs, configuration, permissions, extension points

> **NEXUS — Predict. Learn. Grow.** · Created by Vinayyyy
>
> This document describes every module of the redesigned application: what it does,
> which route renders it, which backend capability it depends on, what it is allowed to
> change, and how to add the next module without touching the shell.

## 1 · Architecture in one screen

| Layer | Location | Responsibility |
| --- | --- | --- |
| Feature registry | `index.html` → `FEATURES` | Single source of truth for sections: `id`, `label`, `icon`, `group`, `mobile`, `note` |
| Router | `showPage()` / `onPageShown()` | Adds/removes `.on` from `#page-<id>`, syncs every nav surface, persists the last page, runs per-page render hooks |
| Navigation | `buildNav()` | Generates the desktop rail, the tab bar and the mobile bar **from the registry** |
| Design system | `index.html` → `<style>` | Tokens (`--nx-*`), Liquid Glass surfaces, primitives, components, responsive rules |
| Chart kit | `chartCandles/chartDonut/chartEquity/chartHBar` | Dependency-free inline SVG built only from real records |
| Signal registry | `sigLog`, `sigLogAdd`, `sigLogSettle` | Durable per-signal record + explicit settlement state, independent of the live engines |
| Brand layer | `nxBrand`, `setBrand`, `applyTheme` | Theme, accent, glass intensity, wallpaper, logo kit, creator card — presentation only |

The application remains a **single static file with no bundler and no CDN**, exactly as
before the redesign. All API access still goes through the authenticated server relay and
the public Supabase anon key.

## 2 · Modules

Every module below states its **purpose**, **route**, **backend dependency**,
**configuration**, **permissions** and **extension points**.

### 2.1 Overview — `dash`
* **Purpose** — live status, market summary, active pairs, recent signals, prediction statistics, system health, recent activity, market regime.
* **Backend** — none on its own; it renders engine state (`cache`, `stat`, `sigLog`, `budget`), relay health (`/api/v1/health`) and, when configured, Supabase freshness views.
* **Configuration** — widget visibility and order (`nx_widgets`, `nx_widgets_hidden`), notification switches.
* **Permissions** — none (read-only presentation).
* **Extension** — add a card with `class="glass nx-widget" data-widget="key" data-widget-title="…"` inside `#page-dash`, then add `key` to `DEF_WIDGETS`. It automatically appears in the widget drawer and inherits show/hide/reorder.

### 2.2 Signals — `sig`
* **Purpose** — scan controls, live M1/M3 streams, multi-agent console, signal history with search, filters, sorting and a detail drawer.
* **Backend** — `POST /api/v1/market` (`time_series` for M1 and `time_series 5min` for the optional M5 filter), `/api/v1/health` for key availability, `predictions` insert when the cloud mirror is on.
* **Configuration** — watchlist, timeframes, timezone offset, signal lead seconds, M5 confirmation, AUTO-MODE, NONSTOP, news blackout.
* **Permissions** — relay session required (anonymous Supabase Auth); no Telegram permission needed.
* **States** — loading (scan in progress), empty (no signals yet / no match for the filter), error (feed error surfaces in the status bar), stale (`candleGate` reason), disabled (`AUTO-MODE` off, blackout on, circuit breaker).
* **Extension** — new filters are one `<option>` plus a clause in `signalRowsForView()`; new columns are one `<th>`/`<td>` pair in the same function.

### 2.3 Markets — `markets`
* **Purpose** — pair explorer, candlestick chart with recorded signal markers, timeframe switch, freshness, pair analysis (regime, agents, family agreement, per-pair history).
* **Backend** — `POST /api/v1/market` with `operation: time_series`. **No new provider endpoint is introduced**; `quote`/`price`/`exchange_rate` remain diagnostic-only on the Data page.
* **Configuration** — chart pair and range; the pair list follows the Signals watchlist.
* **Permissions** — relay session required. `LOAD CANDLES` spends one paid call and respects the shared budget guard.
* **States** — empty (pair has no cached candles), error (budget, weekend, network), stale (gate reason shown in the table).
* **Extension** — additional overlays belong in `chartCandles({marks})`; new analysis blocks are new rows in `renderPairAnalysis()`.

### 2.4 Session — `sess`
* **Purpose** — one-click quality session on the MAIN channel with win target and quality guard.
* **Backend** — `/api/v1/market` (M1 candles) and `/api/v1/telegram` (`sendMessage`, `sendSticker`).
* **Configuration** — win target, quality guard, sticker roles.
* **Permissions** — relay session **and** the local authorize switch **and** the server `NEXUS_TELEGRAM_ADMIN_USER_IDS` allowlist.
* **Unchanged safeguards** — the session floor never decays; every production stream passes `productionGate()`.

### 2.5 VIP shots — `vip`
* **Purpose** — best-available shot every ten minutes, honest grade, automatic verdict.
* **Backend** — `/api/v1/market`, `/api/v1/telegram`.
* **Permissions** — as Session. **Extension** — window length is `DEF_VX`/`vxTick()`; the quality floor is shared with the production gate.

### 2.6 Premium list — `prem`
* **Purpose** — ten-minute live study, deduplicated unique-pair list 40–60 minutes ahead, one verified RESULT message.
* **Backend** — `/api/v1/market` (M1 + aggregation), `/api/v1/telegram`.
* **Configuration** — list size, daily auto-start time, auto-schedule.
* **Extension** — slot maths live in `premiumSlots()`; conviction projection in `projectConv()`.

### 2.7 Bot stream — `bot`
* **Purpose** — live scan signals relayed to MAIN in the operator's format with fast verdicts.
* **Backend** — `/api/v1/telegram`.
* **Permissions** — relay session + local authorize + server allowlist. Sends are blocked before any network call when unauthorized.

### 2.8 Telegram — `tg`
* **Purpose** — server connection state, four channel aliases, sticker bank, message formats, automation switches, tools and activity log.
* **Backend** — `/api/v1/telegram` (`getStickerSet`, `sendSticker`, `sendMessage`, `setMyCommands`, `getUpdates`), `/api/v1/session` for channel aliases.
* **Configuration** — brand display name only; **the bot token and chat destinations are server-only environment values and never enter the browser**.
* **States** — configured / not configured / not allowlisted / authorized / revoked / delivery error (failed sends are logged as failures).

### 2.9 Performance — `res`
* **Purpose** — settled win/loss/push statistics, paper analytics, outcome donut, paper equity curve, pair breakdown, timeframe breakdown, settlement integrity, risk controls, auditable history.
* **Backend** — local paper records (`nx_paper`, `nx_hist`, `nx_siglog`).
* **Labelling** — every figure is labelled **paper / simulated**; nothing is presented as a real account result.
* **Extension** — a new breakdown is a `groupBy()` call plus a table or chart; the integrity note is generated in `renderTfBreakdown()`.

### 2.10 AI learning — `brain`
* **Purpose** — 26 strategy weights per timeframe, backtest, deep training, model versions, promotion state, production gate.
* **Backend** — `/api/v1/market` (5,000-bar walk-forward fetch), Supabase `model_versions` + Storage artifact for the cloud model, `/api/v1/usage` for credit state.
* **Safeguards preserved** — shadow-only training, walk-forward + holdout validation, SHA-256 artifact verification before any weight merge, prediction logic never replaced.
* **States** — not trained / trained locally / cloud weights applied / validation failed (reason surfaced verbatim).

### 2.11 Data & feeds — `data`
* **Purpose** — provider relay state, credit usage and caps, feed diagnostics, community announcements.
* **Backend** — `/api/v1/health`, `/api/v1/usage`, `/api/v1/market`.
* **Permissions** — relay session; usage reads cost zero credits.
* **Security** — the browser never receives provider keys; the local cap can only lower the server ceiling.

### 2.12 Cloud sync — `cloud`
* **Purpose** — Supabase configuration, cloud model apply, simulated performance, market-data health, delivery audit.
* **Backend** — Supabase REST (`predictions`, `model_versions`, `risk_snapshots`, `v_market_freshness`, `v_ingestion_health_public`, `v_deliveries_public`) with the **public anon key only**; relay for authenticated operations.
* **States** — offline / configuration required / connected · recording off / connecting / database unreachable / database ok · relay not authenticated / sync on.

### 2.13 System health — `health` *(new)*
* **Purpose** — one matrix of operational truth: relay, relay session, database, market-data feed, settlement loop, engines, Telegram delivery, worker/ingestion, provider quota, model training, plus a staleness section and the recent delivery audit.
* **Sources** — `/api/v1/health`, `/api/v1/session`, Supabase views, `candleGate()`, engine state, budget guard, brain state. **Worker liveness is inferred only from recorded ingestion runs — never from relay health.**
* **States** — ok / warning / failure, each with the source and the check timestamp. Unreachable services are shown as unreachable.
* **Extension** — append a row in `collectHealthStates()`; the matrix, the overview tile and the rail indicator update automatically.

### 2.14 Settings — `settings` *(new)*
* **Purpose** — appearance (theme: midnight ocean · silver mist · corsair · auto; accent, glass intensity, wallpaper, reduce motion), notifications, security actions, configuration catalogue and data actions.
* **Backend** — none that can be "saved" server-side; the catalogue shows which values are browser-owned, server-owned or computed, so no setting pretends to be authoritative when it is not.
* **Security actions** — revoke Telegram send access, sign out of the relay session, clear cloud configuration. None of these touch server secrets.
* **Extension** — new groups are new `<div class="glass" id="sec-set-*">` blocks; the catalogue row list lives in `renderSettings()`.

### 2.15 Branding studio — `brand` *(new)*
* **Purpose** — wordmark, four logo variants (luminous blue, monochrome silver, minimal outline, premium dark), favicon, app icon, loading mark, wallpaper, tagline, accent, glass intensity, creator card.
* **Backend** — none. **Branding is a presentation layer and cannot touch the engines.** Exports are generated inline as SVG (no external asset, no franchise material).
* **Creator card** — disabled by default; when enabled it requires a name, and every link must be `https://` or it is dropped.
* **Attribution** — “Created by Vinayyyy” is always present in the rail and in the branding section.

## 3 · Cross-cutting rules

1. **No fabricated data.** Every counter, timestamp, rate and state comes from engine state, the relay, the database or the local record stores. Missing data renders as an explicit empty/unavailable state.
2. **No weakened security.** Secrets stay server-side; the browser holds only the public anon key and a short-lived anonymous Auth session. Authorization, rate limits, validation and the credit budget are untouched.
3. **No new provider surface.** The redesign reuses the existing relay operations; no new external endpoint is called.
4. **Manual stays manual.** Historical backfills stay manual; AUTO-MODE, AUTO-SCHEDULE and the quarantine rules are unchanged.
5. **Paper only.** No order placement, no broker connection, no automated trading order was introduced, and none can be enabled from the UI.
6. **Accessibility.** Focus-visible rings, labelled controls, `aria-live` toasts, reduced-motion support, an in-app reduce-motion switch and a solid-background fallback when backdrop blur is unavailable.

## 4 · Adding the next module

1. **Inspect** the registry in `index.html` and pick the group the module belongs to.
2. **Add one entry** to `FEATURES` (`id`, `label`, `icon`, `group`, `mobile`, `note`). The rail, tab bar, mobile bar, command palette and router update themselves.
3. **Add the markup** as `<div class="page" id="page-<id>">` inside `.wrap`, composed from existing design-system components (`glass`, `t`, `nx-kpis`, `nx-table`, `nx-toolbar`, `toggle`, `chip`, …) so it inherits the Liquid Glass language for free.
4. **Add a render hook** in `onPageShown()` and prime it once in `renderDashboardSuite()` if the page must be ready before it is opened.
5. **Wire real data** — reuse an existing relay operation or Supabase view. If the backend genuinely lacks the capability, add it behind the existing relay authorization, quota and validation rules; never simulate a success.
6. **Cover every state** — loading, empty, success, failure, stale and permission-denied.
7. **Extend operations** — add a row to `collectHealthStates()` if the module introduces a service, and a catalogue row in `renderSettings()` if it introduces configuration.
8. **Add regression tests** to `tests/smoke.cjs` (boot integrity, states, permissions, chaos pass) and update this document.
