# NEXUS Improvement Plan — Accuracy & Functionality

**Date:** 2026-10-13 · Companion to `AUDIT.md` · All line refs are `index(1).html`.
Ordered by impact. Tier 0 is mandatory (the learning loop is currently grading signals wrongly); Tiers 1–2 are where real accuracy gains live; Tier 4 adds functionality users will feel.

---

## Tier 0 — Integrity first (the learning loop is lying to you)

Nothing downstream matters until these land — the app is currently *measuring* its own accuracy wrongly, so you can't even tell if the later changes help.

| # | Change | Where | Why it matters |
|---|---|---|---|
| 0.1 | Settle signals only against candle snapshots **fetched after the candle closed** (store fetch time with each cached candle; require `fetchTime > candleCloseTime`, or refetch inside `settleAll`). | `settleAll` L516–527 | Fixes wrong WIN/LOSS verdicts from in-flight candles (audit C1) — corrupts win rate AND weights |
| 0.2 | Move `settleAll()` to **after** the per-pair fetch loop (or per pair after its fetch). | L419 vs L423–427 | Fixes late/missing settlement for non-lead pairs (audit C2) |
| 0.3 | Key settlement on the candle's **UTC timestamp**, not display `HH:MM` + mutable timezone select. | L450–451, L520–523 | Changing TZ mid-flight currently settles the *wrong candle* (audit H2) |
| 0.4 | Persist `openSigs` in `localStorage` (mark stale ones "expired" on load). | L209 | Reloads silently drop pending results → W/L diverge from what the user saw (M1) |
| 0.5 | Safe `localStorage` shim + `r.ok` check in `jget`. | L218–219, L287–288 | App currently dies in private mode; 429s show as JSON parse errors (H3, M3) |

**Validation:** after 0.1–0.3, every ⏳ must resolve within ~2 scans, and `win` must equal the *final* candle open→close. Add a hidden debug panel listing each settlement's candle timestamp + source snapshot age.

---

## Tier 1 — Data quality & timing (biggest cheap accuracy wins)

| # | Change | Impact | Detail |
|---|---|---|---|
| 1.1 | **Fire auto-scans at `secLeft ≤ 5`**, not on minute rollover. | ★★★ | Currently scans at candle *open* (L272) on a 0–2 s old candle → garbage votes + doji filter misfires. Votes should see a ~92 %+ complete candle. |
| 1.2 | **Market-open guard** using `quote.is_market_open` (already returned by `/quote`). | ★★★ | Right now, on weekends/rollover the app happily emits "signals" against Friday's stale candles. Block scans when market closed; show "market closed" status. |
| 1.3 | **Gate signals on feed agreement** (the spread check at `feed4Render` L492–496 already computes it — wire it into `pass`). | ★★ | If quote/price/rate disagree > 0.02 %, data is stale/divergent — no signal. Also blocks wide-spread conditions that eat M1 edge. |
| 1.4 | **Wire ATR% into `pass`** — it's computed in `detectRegime` (L383) but only displayed. Require `atrPct` in a band (e.g. 40–85 percentile): too quiet = noise/spread dominates; too wild = news chaos. | ★★ | Free volatility filter with data you already have. |
| 1.5 | **Use the last *closed* candle for indicator votes**; use the forming candle only for the doji/last-tick check. | ★★ | Eliminates indicator contamination from a half-built candle (EMA/MACD/RSI all shift during the minute). With 1.1 this is less critical but still cleaner. |
| 1.6 | Session filter: disable or de-weight signals in the dead hours (21:00–00:00 UTC) and Friday late NY; boost during London/NY overlap. | ★★ | M1 FX noise/spread regime is strongly time-of-day dependent. Simple UTC-hour table is enough. |
| 1.7 | Timezone via IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) instead of the fixed offset select (L147–151). | ★ | Current offsets break across DST; "UTC+5.5" label bug (L263) disappears. |

---

## Tier 2 — Signal logic (make the votes mean something)

| # | Change | Impact | Detail |
|---|---|---|---|
| 2.1 | **Multi-timeframe confirmation**: fetch `time_series?interval=5min` for the same pair (1 extra credit) and require the M1 signal direction to agree with the M5 EMA(9/21) bias — or add M5 agreement as a large weight multiplier. | ★★★ | Single-biggest typical accuracy lever for M1 systems. Cheap: 1 credit/pair/scan with 50 s cache. |
| 2.2 | **Replace "≥4 of 8 votes" with family confluence** (L448). EMA cross, MACD and Momentum-3 are ~the same bet (trend) and inflate `agreeN`. Require e.g. ≥1 vote from ≥2 *different* families (TREND/MEAN/BREAK/MOM) and net-family agreement. | ★★★ | `FAM` (L211–214) already exists — this is a ~10-line change and fixes a real correlation flaw. |
| 2.3 | **Payout-aware EV gate + honest confidence**: let the user enter their broker payout %; display `EV = conf_adj × payout − (1 − conf_adj)` and block signals with negative EV. At 80 % payout you need >55.6 % true hit rate. | ★★★ | Functionality users can act on; keeps the app honest (see "Honest limits"). |
| 2.4 | Penalize contradictory strong votes (e.g. RSI-4 says CALL while Keltner breakout says PUT): subtract a conflict penalty from `conf`, or require `callN − putN ≥ 3`. | ★★ | Today a 5–3 split with strong weights passes at conf 0.71 — that's a divided house. |
| 2.5 | Walk-forward weighting: `train()` (L389) currently backtests the same 120 bars the decision uses. Train on the first ~80 bars, validate on the last ~40; only trust strategies with `trades ≥ 10` in validation. | ★★ | Removes in-sample optimism from the 35 % backtest term. |
| 2.6 | Calibrate the regime thresholds (0.70/0.75/0.80 at L387) from outcomes: log `(conf, result)` pairs and pick thresholds that historically hit your target hit rate. Until enough data exists, keep the fixed ones. | ★★ | Turns "STRONG threshold" from folklore into measured policy. |
| 2.7 | Grade B at conf 0.70–0.75 is weak — either raise the pass floor to 0.75 or label it "watch-only" (no signal row, or grey row). | ★ | Fewer, better signals beats more mediocre ones for a stats display. |

---

## Tier 3 — Learning system (make "self-learning" real)

| # | Change | Impact | Detail |
|---|---|---|---|
| 3.1 | **Per-regime memory**: store `mem[regime][strategy]` (TREND/RANGE/MIXED) instead of one global bucket (L220–222). A mean-reversion strategy that wins in RANGE and dies in TREND currently gets a middling weight everywhere. | ★★★ | `detectRegime` already labels every scan — just scope the keys. |
| 3.2 | **Per-pair memory** (at least a light version: `mem[strategy][pair]` with a global fallback once n ≥ 15). | ★★ | Strategies behave differently on JPY crosses vs EUR/USD. |
| 3.3 | **Time decay** on live memory (e.g. `w,l` multiplied by 0.99 per settled trade, or windowed last-N). | ★★ | Weights currently fossilize; a regime change in the market never invalidates old lessons. |
| 3.4 | **Minimum-sample gating**: treat `liveWR` as the Laplace prior until `n ≥ 20` (it already is `(w+2)/(w+l+4)` — surface this in the UI as "low sample" so users don't trust noise). | ★ | Honesty + it prevents early lucky streaks from dominating (65 % of weight!). |
| 3.5 | Track **confidence calibration**, not just WR: bucket past signals by grade (A+/A/B) and show hit rate per grade in the History panel. | ★ | This is the stat that actually validates or kills the engine. |
| 3.6 | Persist history rows (currently session-only, L539–542) so calibration data survives reloads. | ★ | Pairs with 0.4. |

---

## Tier 4 — Functionality (features users will feel)

| # | Feature | Detail |
|---|---|---|
| 4.1 | **Browser notifications + audio alert** at `secLeft ≤ 10` when a signal fired (Web Notifications API; vibration already exists L457). |
| 4.2 | **CSV export** of history + signal log (time, pair, dir, grade, conf, votes, outcome) — one `Blob` download. Needed for any serious review of the system. |
| 4.3 | **Sparkline chart** (canvas, no deps) of the last ~60 M1 candles with EMA 9/21 overlays and the current signal marker — visual sanity check before entry. |
| 4.4 | **Honest backtest mode** ("DEEP CHECK" button): one `time_series` call with `outputsize=5000` (~3.5 days of M1) → run `train()` + threshold sweep and show per-strategy and ensemble WR over hundreds of bars instead of 57. Costs 1 credit. This replaces the toy backtest as the 35 % weight source. |
| 4.5 | **Credit budget meter**: track credits vs the free-tier 8/min and 800/day; auto-throttle auto-mode and show "next scan in Xs" instead of erroring into 429s. |
| 4.6 | Circuit breaker upgrade: 15-minute *cooldown timer* instead of manual reset only; distinguish "suppressed" vs "reset" states (remove dead code L404 first). |
| 4.7 | Manual pair entry (any Twelve Data FX symbol) + favorite/pin pairs; auto-rotation should prefer pinned pairs. |
| 4.8 | Optional proxy note: the browser calls Twelve Data directly — fine for personal use; document CORS/key exposure for any hosted deployment. |

---

## Tier 5 — Platform polish (from the audit)

Rename `index(1).html` → `index.html`; README + LICENSE; CSP meta; password-type key input with reveal; keyboard-accessible toggle (drop `display:none` at L45); remove dead `if` (L404); `tzLabel` formatting (L263); DOM APIs instead of `innerHTML` templates (L243/511/540); unit tests for the pure indicator/settlement functions (they're already pure — trivial to test in Node).

---

## Honest limits (read before chasing accuracy)

1. **M1 forex binary options are a negative-EV product by construction.** Typical payouts are 70–95 %, meaning you need a true hit rate above ~52–59 % *after spread* just to break even. M1 EUR/USD noise plus 0.5–1.5 pip spread makes sustained 60 %+ very hard for any retail signal engine — professional HFT firms own that timescale.
2. **You cannot measure gains until Tier 0 is fixed.** Improving thresholds against corrupted settlement data optimizes noise.
3. **57 backtest bars prove nothing.** Tier 4.4 (5 000-bar honest backtest) plus Tier 3.5 (calibration by grade) is the only way to know whether a change helped. Treat every threshold tweak as an experiment: change → run deep backtest + forward-paper-trade ≥ 100 signals → keep or revert.
4. **Regulatory**: retail binary options are banned in the EU/UK and restricted elsewhere (see AUDIT.md §8). The EV display and honest stats are also your best compliance defense — never present win rates without sample size.

---

## Suggested rollout order

1. **Sprint 1 (integrity):** Tier 0 (0.1–0.5) + 1.1 + 1.2 — correct verdicts, correct scan timing, no weekend signals. *This alone will change the displayed win rate — expect it to move, probably down; that's the truth arriving.*
2. **Sprint 2 (signal quality):** 2.1 (M5 filter) + 2.2 (family confluence) + 1.3/1.4 (feed-agreement & ATR gates) + 2.4 (conflict penalty).
3. **Sprint 3 (learning & honesty):** 3.1 (per-regime memory) + 3.3 (decay) + 2.5 (walk-forward) + 4.4 (deep backtest) + 2.3 (EV gate).
4. **Sprint 4 (functionality & polish):** notifications, CSV export, sparkline, credit throttle, Tier 5 items.

Each sprint ends with the same gate: deep-backtest snapshot + calibration-by-grade table, so you can see whether the sprint actually helped.
