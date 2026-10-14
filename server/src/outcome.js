// ── Outcome evaluation math (pure — unit-tested) ────────────────────────
// Direction-adjusted returns from confirmed candles only. Simulated returns
// are always labelled simulated — the website sends signals, it never
// executes trades.

/**
 * Build a trade outcome from a prediction and its candles.
 *
 * @param {object} p        prediction row (direction, target_open_ts, evaluation_horizon)
 * @param {Map<number,{open:number,close:number}>} candles  minute-ts → candle (must include target + exit candles)
 * @param {object} costs    { spread_bps: number, slippage_bps: number }
 * @returns {{exit_ts:string, entry_price:number, exit_price:number, direction_adjusted_return:number,
 *            gross_return_bps:number, estimated_cost_bps:number, net_return_bps:number,
 *            outcome:'win'|'loss'|'breakeven'|'neutral'|'invalid', is_valid:boolean, invalid_reason:string|null}}
 *          | {outcome:'invalid', is_valid:false, invalid_reason:string}   (when candles are missing)
 */
export function evaluateOutcome(p, candles, costs = {}) {
  const spreadBps = Number(costs.spread_bps) || 0;
  const slipBps = Number(costs.slippage_bps) || 0;
  const costBps = spreadBps + slipBps;
  const horizon = Math.max(1, p.evaluation_horizon || 1);
  const targetTs = typeof p.target_open_ts === 'number' ? p.target_open_ts : Date.parse(p.target_open_ts);
  const exitTs = targetTs + (horizon - 1) * 60_000;   // close of the last candle in the horizon
  const entry = candles.get(targetTs);
  const exit = candles.get(exitTs);

  if (!entry || !exit || !Number.isFinite(entry.open) || !Number.isFinite(exit.close)) {
    return { outcome: 'invalid', is_valid: false, invalid_reason: 'candle-missing' };
  }
  if (!(entry.open > 0) || !(exit.close > 0)) {
    return { outcome: 'invalid', is_valid: false, invalid_reason: 'bad-prices' };
  }
  if (p.direction === 'FLAT') {
    return {
      exit_ts: new Date(exitTs + 60_000).toISOString(),
      entry_price: entry.open, exit_price: exit.close,
      direction_adjusted_return: 0,
      gross_return_bps: 0, estimated_cost_bps: costBps, net_return_bps: -costBps,
      outcome: 'neutral', is_valid: true, invalid_reason: null,
    };
  }

  const rawMove = (exit.close - entry.open) / entry.open;            // signed price move
  const signed = p.direction === 'CALL' ? rawMove : -rawMove;       // direction-adjusted
  const grossBps = signed * 10_000;
  const netBps = grossBps - costBps;
  const outcome = Math.abs(netBps) < 1e-9 ? 'breakeven' : netBps > 0 ? 'win' : 'loss';

  return {
    exit_ts: new Date(exitTs + 60_000).toISOString(),
    entry_price: entry.open,
    exit_price: exit.close,
    direction_adjusted_return: +signed.toFixed(10),
    gross_return_bps: +grossBps.toFixed(3),
    estimated_cost_bps: +costBps.toFixed(3),
    net_return_bps: +netBps.toFixed(3),
    outcome, is_valid: true, invalid_reason: null,
  };
}

/** Distinct exit timestamp for a prediction (used by the pending query). */
export function exitTsFor(p) {
  const targetTs = typeof p.target_open_ts === 'number' ? p.target_open_ts : Date.parse(p.target_open_ts);
  const horizon = Math.max(1, p.evaluation_horizon || 1);
  return targetTs + horizon * 60_000;    // close time of the horizon's last candle
}
