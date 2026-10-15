// feature computation tests (pure logic)
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures, computeRSI, computeATRPct, ema, alignMinute, FEATURE_VERSION } from '../src/features.js';

function genCandles(n, start = 1.1000, drift = 0.00002) {
  const t0 = Date.UTC(2026, 9, 14, 0, 0, 0);
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = o + drift;
    out.push({
      ts: t0 + i * 60_000,
      open: o, high: Math.max(o, c) + 0.00001, low: Math.min(o, c) - 0.00001, close: c,
    });
  }
  return out;
}

test('computeFeatures returns null below the minimum window', () => {
  assert.equal(computeFeatures(genCandles(10)), null);
  assert.equal(computeFeatures([]), null);
});

test('computeFeatures produces a deterministic snapshot', () => {
  const candles = genCandles(60);
  const a = computeFeatures(candles.slice(), { nowTs: candles[candles.length - 1].ts });
  const b = computeFeatures(candles.slice(), { nowTs: candles[candles.length - 1].ts });
  assert.deepEqual(a, b);
  assert.equal(a.feature_version, FEATURE_VERSION);
  assert.equal(a.ts, alignMinute(candles[candles.length - 1].ts));
});

test('features are computed from history only (ts = last candle)', () => {
  const candles = genCandles(60);
  const snap = computeFeatures(candles, { nowTs: candles[candles.length - 1].ts });
  assert.equal(snap.features.close, +candles[candles.length - 1].close.toFixed(7));
  assert.equal(snap.features.candle_count, 60);
});

test('rising series → RSI 100, positive ema gap', () => {
  const candles = genCandles(60);
  const snap = computeFeatures(candles, { nowTs: candles[candles.length - 1].ts });
  assert.equal(snap.features.rsi14, 100);                 // monotonic rise
  assert.ok(snap.features.ema_gap_bps > 0);
  assert.ok(snap.features.ret_1m_bps > 0);
});

test('falling series → RSI 0, negative returns', () => {
  const candles = genCandles(60, 1.1000, -0.00002);
  const snap = computeFeatures(candles, { nowTs: candles[candles.length - 1].ts });
  assert.equal(snap.features.rsi14, 0);
  assert.ok(snap.features.ret_1m_bps < 0);
});

test('flat series → range position 0.5, zero returns', () => {
  const candles = genCandles(60, 1.1000, 0);
  const snap = computeFeatures(candles, { nowTs: candles[candles.length - 1].ts });
  assert.equal(snap.features.ret_1m_bps, 0);
  assert.equal(snap.features.range_30m_pos, 0.5);
});

test('RSI bounds on alternating series', () => {
  const closes = [];
  for (let i = 0; i < 100; i++) closes.push(1.1 + (i % 2) * 0.001);
  const r = computeRSI(closes, 14);
  assert.ok(r >= 0 && r <= 100);
});

test('computeRSI needs enough data', () => {
  assert.equal(computeRSI([1, 2], 14), null);
});

test('ema converges toward the recent values', () => {
  const e = ema([1, 1, 1, 1, 1, 5, 5, 5, 5, 5], 4);
  assert.ok(e > 4 && e <= 5);
});

test('computeATRPct returns percent of price', () => {
  const candles = genCandles(30);
  const { atrPct } = computeATRPct(candles, 14);
  assert.ok(atrPct > 0 && atrPct < 1);
});
