// ── Feature snapshot computation (pure — unit-tested) ───────────────────
// Small deterministic features derived from stored 1-minute candles. The
// browser live engine keeps its own richer pipeline; this is the server-side
// snapshot used for the trainer's leakage-free datasets (feature_version
// 'nexus-f1'). Pure function of the candle window — no lookahead.

export const FEATURE_VERSION = 'nexus-f1';

/**
 * @param {Array<{ts:number, open:number, high:number, low:number, close:number}>} candles ascending, oldest first
 * @param {object} opts { rsiPeriod?:14, atrPeriod?:14, emaFast?:9, emaSlow?:21, nowTs?:number }
 * @returns {{ts:number, feature_version:string, features:object}|null}
 */
export function computeFeatures(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const rsiPeriod = opts.rsiPeriod ?? 14;
  const atrPeriod = opts.atrPeriod ?? 14;
  const emaFast = opts.emaFast ?? 9;
  const emaSlow = opts.emaSlow ?? 21;

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const ts = opts.nowTs ?? last.ts;

  const rsi = computeRSI(closes, rsiPeriod);
  const { atrPct } = computeATRPct(candles, atrPeriod);
  const emaF = ema(closes, emaFast);
  const emaS = ema(closes, emaSlow);
  const ret1 = pctChange(closes, 1);
  const ret5 = pctChange(closes, 5);
  const ret15 = pctChange(closes, 15);
  const hi = Math.max(...candles.slice(-30).map(c => c.high));
  const lo = Math.min(...candles.slice(-30).map(c => c.low));
  const vol = mean(candles.slice(-30).map(c => c.high - c.low));

  return {
    ts: alignMinute(ts),
    feature_version: FEATURE_VERSION,
    features: {
      close: +last.close.toFixed(7),
      rsi14: round3(rsi),
      atr_pct: round3(atrPct),
      ema9: +emaF.toFixed(7),
      ema21: +emaS.toFixed(7),
      ema_gap_bps: round3(((emaF - emaS) / emaS) * 10_000),
      ret_1m_bps: round3(ret1),
      ret_5m_bps: round3(ret5),
      ret_15m_bps: round3(ret15),
      range_30m_pos: round3(hi > lo ? (last.close - lo) / (hi - lo) : 0.5),
      avg_body_30m: round7(vol),
      candle_count: candles.length,
    },
  };
}

export function alignMinute(ts) { return Math.floor(ts / 60_000) * 60_000; }

export function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

export function computeATRPct(candles, period = 14) {
  if (candles.length < period + 1) return { atrPct: null };
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const atr = mean(trs.slice(-period));
  const lastClose = candles[candles.length - 1].close;
  return { atrPct: lastClose ? (atr / lastClose) * 100 : null };
}

export function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function pctChange(values, back) {
  if (values.length <= back) return null;
  const a = values[values.length - 1 - back], b = values[values.length - 1];
  return a ? ((b - a) / a) * 10_000 : null;
}
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }
const round3 = v => (v == null || !Number.isFinite(v)) ? null : +v.toFixed(3);
const round7 = v => (v == null || !Number.isFinite(v)) ? null : +v.toFixed(7);
