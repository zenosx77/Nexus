# NEXUS Glass v5.0 · Meridian

A single-file, glassmorphic **multi-pair M1/M3 signal research engine** for binary-options-style
candle prediction — built around **confirmed settlement**, two one-click Telegram shows
(**SESSION** and **PREMIUM LIST**), and a **win-only sticker bank**.

> ⚠️ **Signal-only + paper-trading.** NEXUS never places, clicks, or automates real trades.
> No system can guarantee a win rate; every verdict here is settled from real, confirmed candle
> data and the UI says so plainly. Binary options carry a very high risk of loss.

## What's new in v5.0 (Meridian)

| Area | Change |
|---|---|
| **Verdict correctness** | Targets are keyed to the **feed clock** (not the device clock); a candle settles only when the snapshot postdates its close **and** a confirming candle exists; `close == open` is a **PUSH** (stake refunded, never a loss). This fixes "a win shown as a loss". |
| **Telegram · SESSION** | One click: **intro sticker** → ≥1 signal within 60 s sent straight to the channel → auto-verification → **WIN = ✅ + random sticker from your bank**, **LOSS = OTM 💔 message (never a sticker)**, PUSH = ➖ tie notice → until the win target (default 7) → **summary + your 2 outro stickers**. 2 straight losses pause 5 min; the quality guard stops the session at N losses. |
| **Telegram · PREMIUM LIST** | One click: **intro sticker** → **10-minute market study** → schedules sure-shot windows **4 minutes apart, none inside the study window** (multi-timeframe consensus projection) → sends the picture-format list → verifies every outcome from confirmed closes → **one RESULT message with ✅/❌ ticks + 2 outro stickers**. |
| **Sticker bank** | Capture many stickers from your bot (private chat works now — the old channel-match bug is gone) and assign roles: **INTRO**, **WIN×12** (random per win), **OUTRO 1/2**. Stickers fire on wins, intros and completions only. |
| **Message style** | **HOUSE** (default) re-typesets every message in the NEXUS format — bold brand header, monospace rows, italic disclaimer — so forwarded lists stop looking copied. **VERBATIM** mode still adopts a captured layout with live values merged. (Telegram has no custom fonts; bold/italic/mono entities are the supported typography.) |
| **Multi-pair** | 10 live pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, EUR/JPY, GBP/JPY, NZD/USD, EUR/GBP), parallel fetches, live pair grid, quota-safe round-robin ticker and a **credit budget meter** that throttles cadence before you hit 429s/daily caps. |
| **NONSTOP signals** | ≥1 honest signal per minute while the market is open: strict gates first, then a clearly-labelled relaxed fallback (B−/C grades). The status line and notification centre **never say "no trades"**. |
| **Pages** | Nine ordered tab pages (DASH · SIGNALS · SESSION · PREMIUM · BOT · TELEGRAM · RESULTS · BRAIN · DATA) with a persistent live top bar (price, countdown, heartbeat, bell). |
| **Strategies** | 16 total — adds SuperTrend 10×3, VWAP bounce, CCI-14 flip, Williams %R flip, Parabolic SAR flip, Ichimoku TK cross, ADX DI cross, Heikin-Ashi flip. |
| **Training** | `TRAIN THE DATA AT MAX` — 5,000-candle walk-forward deep training with a 70/30 train/validation split; validated win rates blend into the brain's weights. A **readiness meter** tracks the measured win rate against the 1-loss-in-20 (95%) goal — live trading stays disabled by design. |
| **Branding** | New Meridian mark (rising candles + trend arrow), matching favicon, no third-party artwork. |

## Run it

```bash
npm install     # only needed for the test suite (jsdom)
npm test        # smoke + regression suite (~25 s)
```

Then open `index.html` in a browser (or serve the folder). No build step, no CDN,
everything is one self-contained file with a strict CSP (`api.twelvedata.com` + `api.telegram.org` only).

### Keys (never committed)

1. **Browser slots (recommended):** DATA page → paste up to 4 Twelve Data keys → **SAVE ALL KEYS**.
   Stored only in that browser's localStorage. Keys rotate; quota-hit keys cool down 60 s.
2. **Private file:** create `keys.js` (gitignored) from `keys.example.js` with
   `window.NEXUS_KEYS`, `window.NEXUS_TG_TOKEN`, `window.NEXUS_TG_CHAT`.
3. In-file `PERMANENT_KEYS` exists for private forks — **never commit real keys to a public repo**.

The CI credential guard (`tools/check-public.cjs`) refuses to publish if any key/token would ship.

### Telegram show setup (2 minutes)

1. TELEGRAM page → block **1**: paste bot token + channel (`@yourchannel`), SAVE, flip **AUTHORIZED**.
2. Block **2**: send your stickers to the bot in Telegram → **PULL STICKERS** → assign
   INTRO / WIN+ (several) / OUTRO 1 / OUTRO 2.
3. Block **3**: keep **HOUSE** style (or capture a layout and switch to VERBATIM).
4. Block **4**: enable AUTO-SEND so SESSION/PREMIUM lists, results and stickers go out by themselves.
5. SESSION page → **START SESSION**, or PREMIUM page → **START PREMIUM LIST**.

## Repo map

- `index.html` — the entire app (UI + engines)
- `tests/smoke.cjs` — jsdom regression suite (settlement math, engines, privacy, migrations, chaos pass)
- `tools/check-public.cjs` — credential guard used by the Pages deploy workflow
- `assets/fonts/` — self-hosted Inter variable + OFL 1.1 license
- `AUDIT.md` / `IMPROVEMENTS.md` — historical audit & roadmap (v4.x line references; the v5 rewrite
  implements Tier 0–2 items: confirmed settlement, feed-clock targets, persisted history/CSV,
  budget throttling, multi-pair, notifications)
- `keys.example.js` — private keys template (copy to `keys.js`, gitignored)

## Honesty notes

- The 95% goal is tracked **measured vs. promised** on the BRAIN page — the app will tell you when
  reality falls short instead of dressing it up.
- Premium "sure-shot" windows are multi-timeframe **projections**; distance decay and overextension
  penalties are applied, and the engine sends **nothing** when no window clears the conviction floor.
- Session losses are reported with the OTM 💔 format you asked for, but losses cannot be engineered
  away — the guards (pauses, quality guard, daily stop, breaker) are the protection.
