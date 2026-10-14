# Repository Audit — NEXUS Glass v3.1

**Date:** 2026-10-13 · **Branch:** `arena/ca90ad29-nexus` (from `main` @ `9bbaf7f`) · **Scope:** full repository
**Method:** manual line-by-line review, HTML well-formedness parse, JS syntax check (`node --check`), indicator smoke tests in Node.

All line numbers refer to `index(1).html`.

---

## 1. Executive summary

The repository contains a single deliverable: `index(1).html` (554 lines), a self-contained, mobile-first web app that generates M1 binary-option signals (CALL/PUT) for 10 forex pairs using the Twelve Data API. It includes a regime detector (ADX/ATR), 8 technical strategies with weighted voting, a doji filter, a loss-streak circuit breaker, and a "self-learning" weight system persisted in `localStorage`.

**What works well:** clean, modern, dependency-free frontend; zero third-party scripts (small XSS/supply-chain surface); good status/error UX including quota handling; `encodeURIComponent` on all API params; `rel="noopener"` on the external link; valid HTML and valid JS; indicator math is numerically sane in smoke tests (no NaNs, correct RSI edge behavior 0/100, sensible ADX).

**Main concerns:** the signal **settlement/learning loop can grade signals with incomplete candle data and silently miss outcomes** (2 critical bugs), **auto-mode fires at the wrong time in the candle** (systematically weak signals), **settlement is keyed to a mutable timezone string**, and the app **dies completely if `localStorage` is blocked**. Repository hygiene (filename, README, license) is poor. There is also a product/compliance risk worth flagging for a binary-options signal tool.

**Verdict:** not production-ready in its current form despite the "· production" footer. The critical and high items below are fixable with modest, localized changes.

---

## 2. Inventory & repository hygiene

| Item | Finding | Severity |
|---|---|---|
| Files | Exactly 1 file: `index(1).html` (HTML+CSS+JS inline) | — |
| Filename | `index(1).html` is a browser duplicate-download artifact. GitHub Pages will **not** serve it as the site root. Rename to `index.html`. | **Medium** |
| README | Missing — no setup instructions (how to get a Twelve Data key, how to open/deploy the page) | Medium |
| LICENSE | Missing — all rights reserved by default; unclear if reuse is permitted | Medium |
| History | Single commit `9bbaf7f "Add files via upload"` via the GitHub web UI; no conventional commits, no tags/releases | Low |
| CI / tests | None (understandable for a static page, but the JS logic is testable — the indicator functions are pure) | Low |
| `.gitignore` | Not needed for a static HTML repo | — |

---

## 3. Critical — data integrity of the core loop

### C1. Signals are settled from in-flight (incomplete) candle snapshots
`settleAll()` (L516) grades a signal from whatever candle snapshot is in `cache[sig.pair]`, checking only that the candle's *wall-clock minute has passed* (L525: `Math.floor(cMin/60000) >= Math.floor(nowUTC/60000)`). It never checks that the **snapshot was fetched after the candle closed**.

Timeline: a scan at 12:01:05 caches candle `12:01` while it is still forming (its `close` is a partial value). The 12:02 scan calls `settleAll()` first; the wall-clock check now passes, and the signal is graded `win = t.c > t.o` (L527) using the **partial close**. If price was up mid-candle but closed down, the verdict is wrong.

**Impact:** wrong WIN/LOSS marks, corrupted win-rate stats, and corrupted learning weights (live memory carries 65% of `finalWeights`, L403). This undermines the product's core claim ("self-learning", "Session Result").

**Fix:** store `ck.t` (fetch timestamp) or the candle's close time with each cached candle, and settle only when `snapshotTime > candleCloseTime` (or force a fresh fetch inside `settleAll`).

### C2. `settleAll()` runs before fresh data for non-lead pairs is fetched
In `runScan()` (L419) `settleAll()` is called right after the lead pair's fetch, **before** the per-pair loop fetches `apiTimeSeries` for the other targets (L423–427). Settlement for every non-lead pair therefore depends on a stale `cache` entry — the same cache C1 misuses — and if `cache[sig.pair]` is missing (`if(!ck) return`, L519) the signal simply isn't settled this round. Auto-mode only scans 3 rotating pairs per minute, so a signal on pair B can go unsettled for many scans, or forever if the cache is cleared by a reload.

**Impact:** delayed or permanently missed settlements → the same downstream stat/learning corruption as C1, plus stuck ⏳ rows.

**Fix:** move `settleAll()` to after all pairs' fetches (or call it per pair right after that pair's fetch), and settle against the fresh data.

---

## 4. High

### H1. Auto-mode scans at candle *open*, not pre-close (L272–273)
The 1-second interval triggers `runScan(false)` on the first tick where `d.getUTCMinutes()` changes — i.e. at second 0–1 of the new minute. At that instant the candle being analyzed is 0–2 seconds old (a nearly empty candle):

- indicator votes are computed on a degenerate last bar;
- the doji filter (`body/range < 0.25`, L441) misfires constantly and blocks most auto signals;
- this is the exact opposite of the app's own guidance ("scan a few seconds before candle close for best entry timing", L160).

**Fix:** trigger when the countdown is nearly done, e.g. `secLeft <= 5`, and set `lastMinute` accordingly.

### H2. Settlement is keyed to a mutable display string ("HH:MM") + timezone select (L450–451, L520–523)
`sig.time` is a display-local `HH:MM` formatted with the *current* `#tzoff` value; `settleAll` re-formats every candle with the *then-current* `#tzoff` and string-matches. If the user changes the timezone between issuance and settlement (the select is always enabled), the signal matches the **wrong candle** (wrong verdict) or none (stuck forever). `HH:MM` also collides across days if a signal lingers.

**Fix:** store the target candle's UTC epoch (or its raw `t` string) in `openSigs`, and match on that. Keep display strings for rendering only.

### H3. Unguarded `localStorage` access kills the whole app (L218–219, L259)
`localStorage.getItem('nx_W')` etc. run at top level with no try/catch. In storage-blocked contexts (Safari private mode with blocked storage, disabled cookies, some sandboxed iframes) this throws a `SecurityError` and **no script runs at all** — blank dashboard, no error message. The `try/catch` at L220/L252 only guards `JSON.parse`, not the storage call itself.

**Fix:** a tiny storage shim (`get(k)`/`set(k,v)` with try/catch and in-memory fallback).

---

## 5. Medium

### M1. `openSigs` is in-memory only (L209)
Reloading the page drops all pending signals: their ⏳ rows disappear, verdicts never arrive, and W/L (persisted) diverge from what the user saw. Persist `openSigs` (or mark them "abandoned" on load).

### M2. API key hygiene (L116)
The key input is `type="text"` — visible on screen (shoulder-surfing, screen shares) — and is stored in plaintext `localStorage` (`td_key`, L259). Client-side-only storage is a reasonable design and the UI says so (L117, good), but use `type="password"` with a reveal toggle and note the shared-device risk.

### M3. `jget` ignores HTTP status (L287–288)
`await r.json()` on a non-JSON 429/5xx (proxy error page, rate-limit text) throws a cryptic parse error instead of the quota message built at L470. Check `r.ok` and content-type first.

### M4. Stats/history "reset" semantics are muddled (L194, L234)
The History card's "reset" button calls `clearStats()`, which wipes W/L/streak **and** the visible history but **not** the brain memory `mem` (L220–222) — so "reset" silently preserves the learned weights. Conversely the history *list* is session-only while W/L persist across sessions. Decide what reset means and label it accordingly.

### M5. Statistical validity vs. "self-learning" branding (L390, L403)
`train()` backtests at most ~57 bars (`for(let i=60;i<n-2;i++)`, `outputsize=120`) — far too few samples for meaningful win rates. `finalWeights` = 35% backtest + 65% Laplace-smoothed live memory × regime boost. This is a reasonable heuristic ensemble, but displayed win rates and weight bars can easily be noise, and the UI presents them as learned performance. Keep the disclaimer (L199 — good) prominent and avoid performance claims in any marketing.

### M6. Repository hygiene items
Filename `index(1).html` → `index.html` (required for GitHub Pages); add README + LICENSE. See §2.

---

## 6. Low / polish

| # | Finding | Location |
|---|---|---|
| L1 | Dead code: empty `if(streak>=3 && manual!==null){}` — the breaker is actually enforced in `pass` (L448). Remove. | L404 |
| L2 | `tzLabel()` renders offset 5.5 as "UTC+5.5" instead of "UTC+5:30" (cosmetic mismatch with the select). | L263 |
| L3 | FAIL rows (`addRow(pair,'—:—','FAIL',null)`) never settle — ⚠️ forever. | L430 |
| L4 | XSS sinks (`innerHTML`/`insertAdjacentHTML`) are safe **today** only because every interpolated value is an app-controlled enum/number. Any future user-derived string in these templates becomes XSS. Prefer DOM APIs or an escape helper. | L243, L254, L511, L540 |
| L5 | Accessibility: `.switch input{display:none}` removes keyboard access to the AUTO toggle; no distinct focus rings. Use a visually-hidden (not `display:none`) checkbox pattern. | L45 |
| L6 | Quota math: auto-mode burns ~6 credits/min (3× `time_series` + quote + price + exchange_rate) vs. the free tier's 8/min; a manual SCAN or VERIFY FEEDS in the same minute triggers 429s. Add lightweight rate limiting/backoff. | L287–304 |
| L7 | Edge: a scan spanning a minute boundary computes "next candle" = `now+1min` after fetches complete (L450) — can point at the already-forming candle. Compute the next minute boundary at completion, or at signal-display time. | L450 |
| L8 | No CSP meta. Even with inline JS, `default-src 'self'; connect-src https://api.twelvedata.com; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'` reduces blast radius. | `<head>` |
| L9 | Indicator conventions differ from textbook definitions: BB window excludes the current bar (`slice(i-p,i)`, L328); `stoch()` returns smoothed %K where strategies treat it as %D; Keltner's "ATR" is EMA(10) of TR, not Wilder ATR. Internally consistent (smoke tests pass) — just document the definitions. | L327–335 |
| L10 | `dir` ties default to PUT (L446) — harmless (conf=0.5 never passes the threshold) but make it explicit. | L446 |
| L11 | History list is session-only while counters persist (see M4); consider persisting the list or noting "session view". | L539–542 |

---

## 7. Security review

**Positives**
- No third-party scripts, fonts, or CDNs — fully self-contained (no supply-chain or CDN-compromise surface).
- All network calls go to `https://api.twelvedata.com` over TLS; API params are `encodeURIComponent`-encoded (no URL/query injection).
- External link uses `target="_blank" rel="noopener"` (L117).
- Status/error messages are rendered via `textContent` (L550), not `innerHTML`.
- Pair names and strategy names are fixed enums — current `innerHTML` templates (L243, L511, L540) cannot be attacker-fed from within the app.

**Concerns**
1. API key shown in cleartext input + plaintext `localStorage` (M2). XSS on this origin would exfiltrate it — note there is currently no XSS sink reachable (L4), so the practical risk is mostly shoulder-surfing / shared devices.
2. No CSP (L8) — one injected script would have full run of the page and its storage.
3. Fragile `innerHTML` templating pattern (L4) — safe now, unsafe the moment a user-controlled string is added.
4. No secrets in the repo or git history (checked) — good.

---

## 8. Compliance & product-risk notes (not legal advice)

- **Binary options are banned for retail sale/marketing in the EU/UK** (ESMA/FCA product intervention measures), and heavily restricted elsewhere. Distributing a signal tool branded "NEXUS PREMIUM SIGNAL" with grade badges (A+/A/B) and live win-rate stats may constitute a **financial promotion** in some jurisdictions. Obtain legal review before any public distribution or monetization.
- The in-app disclaimer (L199) is good practice — keep it visible next to stats, not just at page bottom.
- No LICENSE file: add one (and a terms-of-use notice for the trading-risk context).
- Twelve Data free-key usage is per their API ToS; each user bringing their own key is the correct pattern (already implemented).

---

## 9. Recommended action plan

**Fix first (correctness of results & learning):**
1. C1 — settle only against candle snapshots fetched after the candle closed (or refetch in `settleAll`).
2. C2 — call `settleAll()` after all per-pair fetches.
3. H2 — key settlement on candle UTC timestamps, not display `HH:MM` + mutable TZ.
4. H1 — fire auto-scans at `secLeft <= 5`, not on minute rollover.
5. H3 — wrap `localStorage` in a safe shim.

**Then (robustness & trust):**
6. Persist `openSigs` (M1); password-type key input (M2); `r.ok` check in `jget` (M3); clarify reset semantics (M4).

**Repo & product:**
7. Rename `index(1).html` → `index.html`; add README + LICENSE (M6); remove dead code (L1); add CSP meta (L8); fix toggle accessibility (L5).
8. Soften or footnote "self-learning"/win-rate presentation to match the statistics (M5); get compliance review before public distribution (§8).

---

## 10. What was verified during this audit

- ✅ HTML well-formedness: no unclosed/mismatched tags (Python `html.parser`).
- ✅ JS syntax: `node --check` passes on the extracted script (349 lines).
- ✅ Indicator smoke tests (EMA/RSI/ADX): no NaNs; RSI hits 100/0 on monotonic series; ADX reacts directionally as expected.
- ✅ No secrets, binaries, or large artifacts in the tree or git history.
- ✅ No third-party resources referenced.
