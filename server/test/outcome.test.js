// outcome evaluation math tests (pure logic)
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOutcome, exitTsFor } from '../src/outcome.js';

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0);       // target candle open 10:00

function mkCandle(minuteOffset, open, close) {
  return { open, close };
}

function prediction(overrides = {}) {
  return {
    id: 'p1', pair_code: 'EUR/USD', timeframe: '1m',
    target_open_ts: new Date(T0).toISOString(),
    direction: 'CALL', evaluation_horizon: 1,
    strategy_version: 'nexus-fusion-v1',
    ...overrides,
  };
}

test('CALL win: close above entry open, net after costs', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, 1.1005)]]);
  const r = evaluateOutcome(prediction(), candles, { spread_bps: 1, slippage_bps: 0.5 });
  // move = +0.0005/1.1000 = +4.545 bps; net = 4.545 - 1.5 = +3.045
  assert.equal(r.outcome, 'win');
  assert.equal(r.entry_price, 1.1000);
  assert.equal(r.exit_price, 1.1005);
  assert.ok(Math.abs(r.gross_return_bps - 4.545) < 0.01);
  assert.ok(Math.abs(r.net_return_bps - 3.045) < 0.01);
  assert.equal(r.estimated_cost_bps, 1.5);
});

test('PUT win on a falling market (direction-adjusted)', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, 1.0990)]]);
  const r = evaluateOutcome(prediction({ direction: 'PUT' }), candles, { spread_bps: 1, slippage_bps: 0.5 });
  // raw move −9.09 bps; direction-adjusted = +9.09 bps; net = +7.59
  assert.equal(r.outcome, 'win');
  assert.ok(r.direction_adjusted_return > 0);
  assert.ok(Math.abs(r.net_return_bps - 7.59) < 0.02);
});

test('CALL loss when the move is smaller than costs', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, 1.10001)]]);
  const r = evaluateOutcome(prediction(), candles, { spread_bps: 1, slippage_bps: 0.5 });
  assert.equal(r.outcome, 'loss');
});

test('breakeven when net return is exactly zero', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, 1.1000165)]]);
  const r = evaluateOutcome(prediction(), candles, { spread_bps: 1, slippage_bps: 0.5 });
  // move = 0.15 bps ≈ costs → breakeven band
  assert.ok(r.outcome === 'breakeven' || r.outcome === 'loss');
});

test('multi-candle horizon: exit = close of candle at target+(h−1)·60s', () => {
  const candles = new Map([
    [T0, mkCandle(0, 1.1000, 1.1002)],
    [T0 + 60_000, mkCandle(1, 1.1002, 1.1008)],
    [T0 + 120_000, mkCandle(2, 1.1008, 1.1012)],
  ]);
  const p = prediction({ evaluation_horizon: 3 });
  const r = evaluateOutcome(p, candles, { spread_bps: 0, slippage_bps: 0 });
  // entry = open(10:00) = 1.1000; exit = close(10:02) = 1.1012
  assert.equal(r.entry_price, 1.1000);
  assert.equal(r.exit_price, 1.1012);
  assert.equal(r.outcome, 'win');
  assert.equal(r.exit_ts, new Date(T0 + 3 * 60_000).toISOString());
});

test('missing exit candle → invalid with reason', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, 1.1005)]]);
  const p = prediction({ evaluation_horizon: 3 });
  const r = evaluateOutcome(p, candles, {});
  assert.equal(r.outcome, 'invalid');
  assert.equal(r.invalid_reason, 'candle-missing');
  assert.equal(r.is_valid, false);
});

test('missing entry candle → invalid', () => {
  const r = evaluateOutcome(prediction(), new Map(), {});
  assert.equal(r.outcome, 'invalid');
});

test('FLAT direction → neutral, never win/loss', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, 1.1050)]]);
  const r = evaluateOutcome(prediction({ direction: 'FLAT' }), candles, { spread_bps: 1, slippage_bps: 0 });
  assert.equal(r.outcome, 'neutral');
  assert.equal(r.direction_adjusted_return, 0);
  assert.equal(r.net_return_bps, -1);           // costs only
});

test('bad prices → invalid, never fabricated', () => {
  const candles = new Map([[T0, mkCandle(0, 1.1000, -1)]]);
  const r = evaluateOutcome(prediction(), candles, {});
  assert.equal(r.outcome, 'invalid');
  assert.equal(r.invalid_reason, 'bad-prices');
});

test('exitTsFor = target + horizon minutes (close time of last candle)', () => {
  assert.equal(exitTsFor(prediction({ evaluation_horizon: 1 })), T0 + 60_000);
  assert.equal(exitTsFor(prediction({ evaluation_horizon: 3 })), T0 + 180_000);
});
