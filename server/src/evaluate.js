// ── Outcome evaluation ──────────────────────────────────────────────────
// Evaluates predictions whose horizon has elapsed, using confirmed stored
// candles only. Idempotent: trade_outcomes PK = prediction_id, insert-only,
// races resolve as unique-violation skips. Full audit trail lives in
// trade_outcome_revisions (DB trigger). Simulated returns are labelled as
// such everywhere downstream — these are signal-quality metrics, never
// realized account profits.

import { config, log } from './config.js';
import { db, withJobLock } from './db.js';
import { evaluateOutcome, exitTsFor } from './outcome.js';

const TF = '1m';                       // all evaluation reads the 1-minute candle store
const DEFAULT_COSTS = { spread_bps: 1.0, slippage_bps: 0.5 };

/**
 * One bounded evaluation pass.
 * 1. Load predictions due (via v_prediction_accuracy, outcome IS NULL) — limit 200.
 * 2. Load the exact candles each batch needs (one bounded range query per pair).
 * 3. Evaluate; insert-if-absent. Candles still missing after max_delay → 'invalid'.
 */
export async function runEvaluate(opts = {}) {
  const now = opts.now ?? Date.now();
  const graceMs = config.evaluationGraceSeconds * 1000;
  const maxDelayMs = config.evaluationMaxDelayMinutes * 60_000;

  // cheap pre-filter: anything whose exit could be due must have targeted a
  // candle at least (1 candle + grace) ago; the loop re-checks per horizon.
  const cutoff = new Date(now - graceMs - 60_000).toISOString();
  const { data: due, error } = await DBC
    .from('v_prediction_accuracy')
    .select('id, pair_code, timeframe, target_open_ts, direction, evaluation_horizon, strategy_version, outcome')
    .is('outcome', null)
    .eq('is_shadow', false)
    .lte('target_open_ts', cutoff)
    .order('target_open_ts', { ascending: true })
    .limit(200);
  if (error) throw new Error(`due predictions: ${error.message}`);

  const stats = { due: due ? due.length : 0, evaluated: 0, invalid: 0, skipped: 0 };
  if (!due || !due.length) return stats;

  // group by pair to batch candle loads
  const byPair = new Map();
  for (const p of due) {
    if (!byPair.has(p.pair_code)) byPair.set(p.pair_code, []);
    byPair.get(p.pair_code).push(p);
  }

  const { data: pairRows } = await DBC.from('currency_pairs').select('code, spread_bps');
  const spreadMap = new Map((pairRows || []).map(r => [r.code, Number(r.spread_bps) || DEFAULT_COSTS.spread_bps]));

  for (const [pair, preds] of byPair) {
    // candle range covering this whole batch (bounded: max horizon 60 candles)
    const from = Math.min(...preds.map(p => Date.parse(p.target_open_ts)));
    const to = Math.max(...preds.map(p => exitTsFor(p)));
    const { data: candles, error: cErr } = await DBC
      .from('market_candles')
      .select('ts, open, close')
      .eq('pair_code', pair)
      .eq('timeframe', TF)
      .gte('ts', new Date(from).toISOString())
      .lte('ts', new Date(to).toISOString());
    if (cErr) { log('warn', `candle load failed for ${pair}`, cErr.message); stats.skipped += preds.length; continue; }
    const cmap = new Map((candles || []).map(c => [Date.parse(c.ts), { open: Number(c.open), close: Number(c.close) }]));

    for (const p of preds) {
      const closeTime = exitTsFor(p);
      if (closeTime + graceMs > now) { stats.skipped += 1; continue; }        // not yet due

      const costs = {
        spread_bps: spreadMap.get(pair) ?? DEFAULT_COSTS.spread_bps,
        slippage_bps: DEFAULT_COSTS.slippage_bps,
      };
      const r = evaluateOutcome(p, cmap, costs);

      if (r.outcome === 'invalid' && r.invalid_reason === 'candle-missing' && closeTime + maxDelayMs > now) {
        stats.skipped += 1;                                                  // still waiting for candles
        continue;
      }

      const { error: insErr } = await DBC.from('trade_outcomes').insert({
        prediction_id: p.id,
        evaluation_horizon: Math.max(1, p.evaluation_horizon || 1),
        exit_ts: r.exit_ts ?? new Date(closeTime).toISOString(),
        entry_price: r.entry_price ?? null,
        exit_price: r.exit_price ?? null,
        direction_adjusted_return: r.direction_adjusted_return ?? null,
        gross_return_bps: r.gross_return_bps ?? null,
        estimated_cost_bps: r.estimated_cost_bps ?? costs.spread_bps + costs.slippage_bps,
        net_return_bps: r.net_return_bps ?? null,
        outcome: r.outcome,
        is_valid: r.is_valid ?? true,
        invalid_reason: r.invalid_reason ?? null,
        evaluated_by: 'nexus-worker',
      });
      if (insErr) {
        if (insErr.code === '23505') { stats.skipped += 1; continue; }       // already evaluated (race) — fine
        log('warn', `outcome insert failed for ${p.id}`, insErr.message);
        stats.skipped += 1;
        continue;
      }
      if (r.outcome === 'invalid') stats.invalid += 1; else stats.evaluated += 1;
    }
  }
  log('info', 'evaluate pass', stats);
  return stats;
}

/** Locked pass (used by the loop and CLI). */
export function evaluateLocked() {
  return withJobLock('evaluate', 300, () => runEvaluate());
}
