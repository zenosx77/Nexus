# NEXUS Glass v5.1 · Meridian

A single-file, glassmorphic **multi-pair M1/M3 signal research engine** for binary-options-style
candle prediction — built around **4 Telegram channels** (PUBLIC · VIP · LIST · MAIN),
**bot-configured message formats**, a **per-event sticker bank**, **fast confirmed settlement**
and **quality-first signals**.

> ⚠️ **Signal-only + paper-trading.** NEXUS never places, clicks, or automates real trades.
> No system can guarantee a win rate — VIP posts the *best available* window and simply skips
> when there is no clean shot, but losses can and do happen. Every verdict is settled from real,
> confirmed candle data. Binary options carry a very high risk of loss.

## What's new in v5.1 (Meridian)

| Area | Change |
|---|---|
| **4 channels** | One bot, four destinations set on the TELEGRAM page: **MAIN** (session show + bot stream), **PUBLIC** (normal 1-min signals + announcements), **VIP** (one high-grade shot every 10 min), **LIST** (premium lists + results). Empty channels fall back to MAIN. |
| **PUBLIC stream** | One **quality-only** signal per minute (B grade and above, no relaxed fallback), computed and delivered **seconds before the candle opens** so subscribers can enter at the open. Skips the minute when nothing qualifies. |
| **VIP stream** | Every 10 minutes the best available shot across all pairs goes to the VIP channel ~20 s before the candle opens, **grade shown honestly** (A+/A/B). Never a filler shot. |
| **Fast verification** | Verdicts settle **seconds after the candle closes** — the old confirming-candle wait (up to an extra minute) is gone. Pending candles fetch in parallel and retry every ~4 s. |
| **Quality first** | NONSTOP relaxed signals are **off by default**; the SESSION floor **never decays** into low grades — it waits for quality. 26 strategies (10 new: TRIX, Awesome Oscillator, Chande Momentum, Envelope stretch, BB squeeze break, Fractal breakout, EMA-50 pullback, ROC flip, 3-bar reversal, Stoch+RSI combo). |
| **API credit usage** | A dedicated **API CREDIT USAGE** section reads each key's real spend from Twelve Data's `api_usage` endpoint (0 credits) with per-key bars, remaining counts and a live call meter. |
| **10 API keys** | Up from 4 — ten rotating slots with quota cooldown, plus PERMANENT_KEYS / keys.js sources merged into one pool. |
| **Bot-configured formats** | Text `/setformat signal` (or `vip` · `row` · `list` · `result` · `verdict`) with your layout — placeholders like `{pair} {dir} {time} {grade}`, markup `*bold* _italic_ \`code\`` — saved permanently. `/formats` lists them, `/resetformat` restores defaults. Defaults are **ultra-minimal**: pair · direction · entry time · 1-min expiry. |
| **Premium emoji** | Telegram **blocks bots from sending premium/custom emoji** — the format engine never emits those entities, so pasted premium emoji are auto-normalized to regular emoji and messages can never fail on them. |
| **Sticker bank v2** | Nine assignable events: **SESSION START · WIN (bank) · LOSS · PUSH · VIP SHOT · LIST POST · RESULT · OUTRO 1 · OUTRO 2**. Nothing fires unless you assigned it, each event fires **exactly once** (the double-sticker bug is fixed), and empty = silence. |
| **Simpler copy** | Verbose paragraphs trimmed across every page; the old HOUSE/VERBATIM style-capture system is replaced by the simple `/setformat` engine. |

## Run it

```bash
npm install     # only needed for the test suite (jsdom)
npm test        # smoke + regression suite (~40 s)
```

Then open `index.html` in a browser (or serve the folder). No build step, no CDN,
everything is one self-contained file with a strict CSP (`api.twelvedata.com` + `api.telegram.org` only).

### Keys (never committed)

1. **Browser slots (recommended):** DATA page → paste up to **10** Twelve Data keys → **SAVE ALL KEYS**.
   Stored only in that browser's localStorage. Keys rotate; quota-hit keys cool down 60 s.
2. **Private file:** create `keys.js` (gitignored) from `keys.example.js` with
   `window.NEXUS_KEYS`, `window.NEXUS_TG_TOKEN`, `window.NEXUS_TG_CHAT`.
3. In-file `PERMANENT_KEYS` exists for private forks — **never commit real keys to a public repo**.

The CI credential guard (`tools/check-public.cjs`) refuses to publish if any key/token would ship.

### Telegram setup (3 minutes)

1. **TELEGRAM page → block 1:** paste the bot token, your brand, and the four channels
   (MAIN · PUBLIC · VIP · LIST — empty ones fall back to MAIN). Add the bot as **admin** in each channel. SAVE, flip **AUTHORIZED**.
2. **Block 2:** send your stickers to the bot in Telegram → **PULL STICKERS** → assign each one to its event (session start, win bank, loss, push, vip, list, result, outro 1/2). Unassigned = never sent.
3. **Block 3:** text `/setformat signal <your layout>` to the bot to set your own message formats permanently (or keep the ultra-minimal defaults).
4. **Block 4:** flip the automation switches — **PUBLIC STREAM** (1 quality signal/min), **VIP STREAM** (best shot every 10 min), auto list + result, bot stream, verdicts.
5. SESSION page → **START SESSION**, PREMIUM page → **START PREMIUM LIST**, VIP page → **FIRE VIP SHOT NOW** — or use `/session`, `/premium`, `/vip` in the bot chat.

### Bot commands

`/start` `/help` `/session` `/premium` `/vip` `/signal` `/list` `/results` `/stats`
`/formats` `/setformat <kind> <layout>` `/resetformat <kind|all>`

## Repo map

- `index.html` — the entire app (UI + engines)
- `tests/smoke.cjs` — jsdom regression suite (settlement math, channels, formats, sticker dedupe, engines, privacy, migrations, chaos pass)
- `tools/check-public.cjs` — credential guard used by the Pages deploy workflow
