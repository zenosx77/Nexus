# NEXUS Glass v5.2 · Meridian

A single-file, glassmorphic **multi-pair M1/M3 signal research engine** for binary-options-style
candle prediction — built around **4 Telegram channels** (PUBLIC · VIP · LIST · MAIN),
**bot-configured message formats**, a **per-event sticker bank**, **revision-safe confirmed settlement**
and **quality-first signals**.

> ⚠️ **Signal-only + paper-trading.** NEXUS never places, clicks, or automates real trades.
> No system can guarantee a win rate — VIP posts the *best available* window and simply skips
> when there is no clean shot, but losses can and do happen. Every verdict is settled from real,
> confirmed candle data. Binary options carry a very high risk of loss.

## What's new in v5.2 (Meridian)

| Area | Change |
|---|---|
| **4 channels** | One bot, four destinations set on the TELEGRAM page: **MAIN** (session show + bot stream), **PUBLIC** (normal 1-min signals + announcements), **VIP** (one high-grade shot every 10 min), **LIST** (premium lists + results). Empty channels fall back to MAIN. |
| **PUBLIC stream** | One **quality-only** signal per minute (B grade and above, no relaxed fallback), computed and delivered **seconds before the candle opens** so subscribers can enter at the open. Skips the minute when nothing qualifies. |
| **VIP stream** | Every 10 minutes the best setup that clears the quality, EV, timing and market gates goes to VIP before the candle opens. If none qualifies, the slot is skipped—never filled with a weak trade. |
| **Future premium lists** | The 10-minute study takes a fresh snapshot every minute, refreshes once more before production, and publishes unique-pair windows **40–60 minutes ahead**. The conviction floor is never silently relaxed. |
| **Stable verification** | Verdicts wait through an 8-second provider revision window, then settle from the exact target candle keyed by UTC epoch. A verdict is final; a provisional close can no longer flash LOSS and later become WIN. |
| **Paper-first production gate** | Telegram signal/list production remains locked until there are ≥100 confirmed paper outcomes, ≥70% measured wins, a 95% Wilson lower bound above payout break-even, and ≥50 profitable deep-validation trades. Local paper scanning remains active to collect honest evidence. Passing the gate reduces risk but never guarantees a future win. |
| **Figma-style product polish** | Responsive page reveals, staggered cards, hover depth, button ripples, ambient motion, toast feedback, online/offline status, back-to-top, and a searchable **Ctrl/⌘ K command palette**. Motion automatically disables when the operating system requests reduced motion. |
| **Quality first** | NONSTOP relaxed signals are **off by default**; the SESSION floor **never decays** into low grades — it waits for quality. 26 strategies (10 new: TRIX, Awesome Oscillator, Chande Momentum, Envelope stretch, BB squeeze break, Fractal breakout, EMA-50 pullback, ROC flip, 3-bar reversal, Stoch+RSI combo). |
| **API credit usage** | **API CREDIT USAGE** reads each key's real spend from Twelve Data's free `api_usage` endpoint and provides editable daily/minute hard caps. Defaults are 700/day + 7/min (not multiplied by key count); new scans pause at 80%, reserving headroom for settlements. The worker has a separate persistent Supabase-backed cap. |
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
everything is one self-contained file with a strict CSP (`api.twelvedata.com` + `api.telegram.org`
+ `*.supabase.co` when cloud sync is configured).

### Keys (never committed)

1. **Browser slots (recommended):** DATA page → paste up to **10** Twelve Data keys → **SAVE ALL KEYS**.
   Stored only in that browser's localStorage. Keys rotate; quota-hit keys cool down 60 s.
2. **Private file:** create `keys.js` (gitignored) from `keys.example.js` with
   `window.NEXUS_KEYS`, `window.NEXUS_TG_TOKEN`, `window.NEXUS_TG_CHAT`.
3. In-file `PERMANENT_KEYS` exists for private forks — **never commit real keys to a public repo**.

The CI credential guard (`tools/check-public.cjs`) refuses to publish if any key/token would ship.

### Control API credits

On the **DATA → API CREDIT USAGE** card, set a daily hard cap and per-minute cap (defaults: **700/day, 7/minute**). The browser stores these limits and its request counter in that browser only. Scans slow at 60%; at 80%, new paid scans pause and pending settlements may use the 20% reserve; the hard cap blocks every paid data request until 00:00 UTC or the cap is raised. The free `api_usage` CHECK shows actual provider spend by key, including use from other devices. Multiple keys do **not** automatically raise the local cap.

The `server/` worker is controlled separately via `TWELVEDATA_DAILY_CREDIT_LIMIT` and `TWELVEDATA_PER_MINUTE_LIMIT`; its reservation count is persistent in Supabase after migration 0007. Browser and worker limits are independent—if they share a Twelve Data account, configure their combined allowance below your plan limit and reconcile with `api_usage`.

### Telegram setup (3 minutes)

1. **TELEGRAM page → block 1:** paste the bot token, your brand, and the four channels
   (MAIN · PUBLIC · VIP · LIST — empty ones fall back to MAIN). Add the bot as **admin** in each channel. SAVE, flip **AUTHORIZED**.
2. **Block 2:** send your stickers to the bot in Telegram → **PULL STICKERS** → assign each one to its event (session start, win bank, loss, push, vip, list, result, outro 1/2). Unassigned = never sent.
3. **Block 3:** text `/setformat signal <your layout>` to the bot to set your own message formats permanently (or keep the ultra-minimal defaults).
4. **Block 4:** flip the automation switches — **PUBLIC STREAM** (1 quality signal/min), **VIP STREAM** (best shot every 10 min), auto list + result, bot stream, verdicts.
5. SESSION page → **START SESSION**, PREMIUM page → **START PREMIUM LIST**, VIP page → **FIRE VIP SHOT NOW** — or use `/session`, `/premium`, `/vip` in the bot chat.

### Continuous operation (important)

**The public website and its engines are different things.** GitHub Pages serves the static UI 24/7 after the deploy workflow publishes `main`; this branch's changes go live after they are merged to `main`. Browser-only scans and Telegram streams run only while the page is open and the device/tab is awake—browsers can suspend timers, so this is not reliable unattended hosting. For background ingestion, evaluation, retries and alerts, deploy `server/` to an always-on VPS and keep it alive with PM2/systemd (exact commands in [server/README.md](server/README.md)). Apply migrations 0001–0007 first. The worker's safe default credit cap spaces data ingestion; real-time all-pair coverage needs a provider plan sized for it. Forex market feeds intentionally pause over weekends and safety gates may suppress signals. “24/7” never means forcing a trade when no setup qualifies.

### Bot commands

`/start` `/help` `/session` `/premium` `/vip` `/signal` `/list` `/results` `/stats`
`/formats` `/setformat <kind> <layout>` `/resetformat <kind|all>`

## Cloud sync (Supabase — optional)

The engine runs **fully offline by default**. If you want server-grade record-keeping,
outcome evaluation, risk monitoring and self-learning, connect a Supabase project:

- **CLOUD page** in the app — paste the project URL + **anon public key** (never the
  service-role key). The browser *mirrors* signals and delivery results (insert-only,
  enforced by row-level security) and can apply SHA-256-verified cloud-trained weights
  to the brain — a button, never silent. With no config every cloud call is a no-op.
- **`server/`** — Node worker (service-role key, server only): 1-minute candle ingestion
  with gap/duplicate/revision detection, outcome evaluation (direction-adjusted returns
  minus estimated costs), risk snapshots, Telegram retries, ops alerts, retention.
- **`trainer/`** — Python trainer (stdlib only): leakage-free chronological walk-forward
  training, gated promotion (shadow mode first), rollback support, private model artifacts.
- **`supabase/migrations/`** — versioned SQL schema (core tables plus the worker credit-budget table, views, RLS and retention).

Full setup: **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** · architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Simulated returns shown anywhere (cloud performance included) are **signal-quality
metrics, never realized account profits**.

## Repo map

- `index.html` — the entire app (UI + engines)
- `tests/smoke.cjs` — jsdom regression suite (settlement math, channels, formats, sticker dedupe, engines, privacy, migrations, cloud mirror, chaos pass)
- `tools/check-public.cjs` — credential guard used by the Pages deploy workflow
- `server/` — Supabase worker (ingestion, evaluation, risk, retries, alerts) — `npm test` inside
- `trainer/` — Python trainer + promotion pipeline — `python3 -m unittest` inside
- `supabase/migrations/` — versioned database schema
- `docs/ARCHITECTURE.md` — inspection report + target architecture
- `SUPABASE_SETUP.md` — end-to-end cloud setup guide
