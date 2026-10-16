// ── Risk / performance snapshots ────────────────────────────────────────
// Rolling win rate, expectancy, profit factor, drawdown and losing streaks
// per scope (global / pair / model / strategy) and window (w20 / w100 / all).
// Accuracy is computed separately from SIMULATED net returns — every consumer
// labels these returns as simulated; they are signal-quality metrics, not
// realized account profits.

import { log } from './config.js';
import { db, withJobLock } from './db.js';

/**
 * Pure statistic computation over outcome rows (any order — sorted internally).
 * @param {Array<{outcome:string, net_return_bps:number, evaluated_at?:string}>} rows
 * @returns {{sample_size,wins,losses,breakeven,neutral,win_rate,expectancy_bps,
 *            profit_factor,net_return_bps,max_drawdown_bps,current_losing_streak,max_losing_streak}|null}
 */
export function computeRiskStats(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    String(a.evaluated_at || '').localeCompare(String(b.evaluated_at || '')));

  let wins = 0, losses = 0, breakeven = 0, neutral = 0;
  let grossWin = 0, grossLoss = 0;                 // absolute bps
  let net = 0, peak = 0, maxDd = 0;
  let curLossStreak = 0, maxLossStreak = 0;

  for (const r of sorted) {
    const o = r.outcome;
    if (o === 'win') {
      wins += 1; curLossStreak = 0;
      const bps = Math.abs(Number(r.net_return_bps) || 0);
      grossWin += bps; net += Number(r.net_return_bps) || 0;
    } else if (o === 'loss') {
      losses += 1; curLossStreak += 1; maxLossStreak = Math.max(maxLossStreak, curLossStreak);
      const bps = Math.abs(Number(r.net_return_bps) || 0);
      grossLoss += bps; net += Number(r.net_return_bps) || 0;
    } else if (o === 'breakeven') {
      breakeven += 1; net += Number(r.net_return_bps) || 0;
    } else if (o === 'neutral' || o === 'invalid') {
      neutral += 1;                                 // excluded from decisive stats
    }
    if (net > peak) peak = net;
    if (peak - net > maxDd) maxDd = peak - net;
  }

  const decisive = wins + losses;
  return {
    sample_size: sorted.length,
    wins, losses, breakeven, neutral,
    win_rate: decisive ? +(wins / decisive).toFixed(4) : null,
    expectancy_bps: decisive ? +(net / decisive).toFixed(3) : null,
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : (grossWin > 0 ? null : 0),
    net_return_bps: +net.toFixed(3),
    max_drawdown_bps: +maxDd.toFixed(3),
    current_losing_streak: curLossStreak,
    max_losing_streak: maxLossStreak,
  };
}

const WINDOWS = { w20: 20, w100: 100, all: null };

/**
 * Snapshot every scope × window from evaluated outcomes (bounded: last 500
 * valid outcomes per scope). Idempotent per (scope, window, as_of-minute).
 */
export async function runRiskSnapshots(opts = {}) {
  const DBC = await db();
  const asOf = new Date(opts.now ?? Date.now());
  asOf.setSeconds(0, 0);                            // minute granularity → natural dedupe

  // one bounded fetch of recent joined rows, group in memory
  const { data: rows, error } = await DBC
    .from('v_prediction_accuracy')
    .select('pair_code, strategy_version, model_version, outcome, net_return_bps, evaluated_at')
    .not('outcome', 'is', null)
    .order('evaluated_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(`risk fetch: ${error.message}`);
  if (!rows || !rows.length) return { scopes: 0 };

  const scopes = new Map();
  const add = (scope, r) => {
    if (!scopes.has(scope)) scopes.set(scope, []);
    scopes.get(scope).push(r);
  };
  for (const r of rows) {
    add('global', r);
    add(`pair:${r.pair_code}`, r);
    add(`strategy:${r.strategy_version}`, r);
    if (r.model_version) add(`model:${r.model_version}`, r);
  }

  const inserts = [];
  for (const [scope, all] of scopes) {
    for (const [window, n] of Object.entries(WINDOWS)) {
      const slice = n ? all.slice(0, n) : all;
      if (!slice.length) continue;
      const st = computeRiskStats(slice);
      if (!st) continue;
      inserts.push({
        scope, window, as_of: asOf.toISOString(),
        sample_size: st.sample_size, wins: st.wins, losses: st.losses,
        breakeven: st.breakeven, neutral: st.neutral,
        win_rate: st.win_rate, expectancy_bps: st.expectancy_bps,
        profit_factor: st.profit_factor, net_return_bps: st.net_return_bps,
        max_drawdown_bps: st.max_drawdown_bps,
        current_losing_streak: st.current_losing_streak,
        max_losing_streak: st.max_losing_streak,
      });
    }
  }
  // unique (scope, window, as_of) — ignore duplicates from concurrent workers
  let written = 0;
  for (let i = 0; i < inserts.length; i += 100) {
    const { error: insErr } = await DBC.from('risk_snapshots')
      .upsert(inserts.slice(i, i + 100), { onConflict: 'scope,window,as_of', ignoreDuplicates: true });
    if (insErr) log('warn', 'risk snapshot insert failed', insErr.message);
    else written += Math.min(100, inserts.length - i);
  }
  log('info', `risk snapshots: ${inserts.length} rows across ${scopes.size} scopes`);
  return { scopes: scopes.size, rows: written };
}

/** Latest snapshot per scope+window (bounded) — used by alerts + dashboard. */
export async function latestSnapshots() {
  const DBC = await db();
  const { data, error } = await DBC
    .from('risk_snapshots')
    .select('scope, window, as_of, win_rate, expectancy_bps, profit_factor, current_losing_streak, sample_size')
    .order('as_of', { ascending: false })
    .limit(500);
  if (error) throw new Error(`snapshots: ${error.message}`);
  const seen = new Set();
  const out = [];
  for (const r of data || []) {
    const k = `${r.scope}|${r.window}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function riskLocked(opts = {}) {
  return opts.db ? runRiskSnapshots(opts) : withJobLock('risk', 300, () => runRiskSnapshots(opts));
}
