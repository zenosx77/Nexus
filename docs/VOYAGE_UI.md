# NEXUS · Voyage interface — reference-matched Liquid Glass UI

> NEXUS — **Predict. Learn. Grow.** · Created by Vinayyyy
>
> This document maps the approved visual reference (the cinematic ocean “NEXUS”
> concept board) to the implementation in `index.html`, lists the reusable
> components that carry the design across every route, and records how the
> result was verified. Presentation only: no engine, settlement, quota or
> delivery behaviour was touched.

## 1 · What changed, and why the old build did not match

The previous build was a generic admin dashboard: a full-height opaque sidebar,
a sticky toolbar with a brand chip + live price chip, a **15-button horizontal
tab bar**, and vertically stacked equal-width cards. The reference has a very
different composition, so the shell was rebuilt rather than re-skinned.

| Reference element | Previous build | Now |
| --- | --- | --- |
| Three columns: nav rail · workspace · creator panel | two columns (rail + content) | `.app-shell` grid — rail, workspace, creator rail at ≥1440 px |
| Cinematic ocean hero banner with the wordmark inside it | flat dark topbar with a chip row | `.topbar` is a 252 px artwork banner containing logo, live pill, icon buttons, wordmark, tagline, three descriptor words and the live heartbeat |
| Summary row of four glass cards with icons | one wide “Market summary” KPI card | `.nx-statrow` → four `.stat-card`s |
| Large candlestick chart beside a signal list | dark chart card below the fold | `#sec-dash-chart` + `#sec-dash-signals` in `.ov-grid.split-2` |
| Four “module” feature cards with status dots | *(absent)* | `#sec-dash-features` → `.feat-card`s driven by real module state |
| Market overview · performance donut · system health | market summary · prediction stats · health list | `.ov-grid.split-3` with `#sec-dash-market`, `#sec-dash-stats` (accuracy ring + P/L curve), `#sec-dash-health` (status rows + uptime footer) |
| Per-page nav (no giant tab bar on desktop) | always-visible 15-tab bar | desktop navigation is the rail only; `.pagetabs` is the compact fallback below 1080 px |
| Bottom branding strip: logo variations, design tokens, saturn, mini brand block | *(absent)* | `.brand-strip` |
| Creator panel with artwork, avatar, bio, socials, live state | *(absent)* | `.creator-rail` |

## 2 · Design system additions

* **Tokens** — midnight-ocean palette (`--scene-*` artwork tints, `--glass-*`
  surfaces), `--nx-accent-ui` for large surfaces, `--display` for the Cinzel
  wordmark, `--rail` / `--creator` / `--shell-pad` for the three-column shell.
  Glass got *more* transparent (`--glass-1 .075`, `--glass-2 rgba(15,27,48,.38)`,
  blur 16 px) so the artwork stays visible behind every panel.
* **Specular edge** — `.glass::before` adds the thin top highlight the reference
  shows on every card; `--glass-inner` adds the soft inner reflection.
* **Type** — Inter (self-hosted, variable) for UI, **Cinzel** (self-hosted, OFL,
  `assets/fonts/cinzel-latin-*-normal.woff2`) for the NEXUS wordmark, rail mark,
  creator name, page-hero titles and strip wordmarks. Both faces ship with their
  OFL licence files and are listed in `tools/build-public.cjs` and the Pages
  workflow, so the public artifact renders identically offline.
* **Icons** — `NX_ICONS` + `nxIcon()` provide 18 inline line-art icons; the
  registry (`FEATURES`) drives the rail, tab bar and mobile bar, so every nav
  surface shows icon art instead of emoji glyphs.
* **Currency marks** — `NX_FLAGS` + `nxFlag()` draw circular pair marks from real
  code (no third-party flag assets).

## 3 · Original artwork (no third-party images)

`nxOceanScene()` is a deterministic, token-tinted SVG generator: layered cloud
banks with lit crowns and dark undersides, a sun/moon with light shafts, a warm
horizon band, procedural swells, a sun column on the water, a distant sail and a
foreground cliff with a silhouetted adventurer. Named presets (`voyage`, `dawn`,
`horizon`, `fleet`, `crest`) are used by:

* the page backdrop (`#nxScene`, `.nx-scene`),
* the hero banner (`#heroArt`, wide 470 px crop),
* the nav-rail vignette (`#railArt`),
* every non-Overview route hero (`renderPageHeroes()`),
* the creator panel (`#crHero`) and the strip tiles.

`nxCrest()`, `nxAvatar()`, `nxSaturn()` and `nxFigure()` provide the engraving,
avatar and planet marks. All are inline SVG — the CSP needs no image hosts, and
the artwork respects `--scene-opacity` (Settings → artwork intensity) and the
reduced-motion switch.

## 4 · New / changed modules

| Function | Purpose |
| --- | --- |
| `renderShellArt()` | mounts hero, rail, creator and strip artwork |
| `renderPageHeroes()` | one `.page-hero` per route, built from the feature registry |
| `renderStripBrand()` / `renderCreatorLinks()` | logo variations, swatches, social links |
| `renderHeroState()` | honest live pill: *System Online* only while an engine runs on a fresh feed; otherwise idle/stale/unreachable |
| `layoutCreatorRail()` | keeps the creator panel as the third column ≥1440 px and folds it into the workspace as a three-card row below that |
| `renderDashChart()` | Overview candlestick panel from the engine's candle cache (pair + timeframe pickers, last-price marker) |
| `renderDashPerf()` | accuracy ring + cumulative paper P/L curve (`LAST 7 DAYS` / `30D` / `ALL`) |
| `renderDashFeatures()` | four module cards with real state (cloud, Telegram, training, settlement) |
| `renderDashMarket()` | Forex/Crypto/Indices/Commodities tabs; only the FX tab lists data, the others state plainly that no feed is configured |
| `renderDashSummary()` / `renderDashSignals()` / `renderDashHealth()` / `renderRailStatus()` | rewritten for the reference card, table and status-row layouts |
| `chartCandles(..., {lastLine:true})` | optional dashed last-price line with a price tag (real cached close only) |

Widget layout: cards keep their home band (`WIDGET_HOME`), so the Overview
widget drawer can reorder or hide cards without ever scrambling the reference
composition.

## 5 · Verification

* `npm test` — browser suite (boot, DOM integrity, engine, quota, cloud, chaos
  pass, design system), relay/worker tests, trainer tests, security checks,
  public-artifact guard, workflow tests, secret scan, quota tests, `deno check`.
* Screenshots at 1600 / 1280 / 900 / 390 px in dark **and** light theme, empty
  and populated (seeded candle cache + settled trades), plus all 15 routes.
* Populated Overview was compared against the reference section by section:
  hero, summary cards, chart + recent signals, module cards, market overview /
  performance / system health, live status + active pairs, branding strip.

Re-verify locally:

```bash
python3 -m http.server 8080          # serve the repo
# open http://127.0.0.1:8080/index.html at 1600x1000 and 390x844
npm test                             # full regression suite
npm run check:public                 # public artifact (fonts included) + credential guard
```

## 6 · Honesty rules that the redesign preserves

* No number is invented: every counter, chart, table row and status dot reads the
  engine's own state or reports “not configured / none / stale”.
* The live pill never claims connectivity that does not exist.
* The module cards show real states (`Not configured`, `Idle`, `Ready / idle`,
  `No verdicts yet`) rather than decorative green dots.
* Pending signals are never shown as wins; the accuracy ring shows `—` until
  verdicts settle.
