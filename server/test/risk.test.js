// risk statistics tests (pure logic)
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRiskStats } from '../src/risk.js';

function rows(list) {
  // list of [outcome, netBps, minutesAgo]
  const now = Date.now();
  return list.map(([outcome, net_return_bps, mins]) => ({
    outcome, net_return_bps, evaluated_at: new Date(now - mins * 60_000).toISOString(),
  }));
}

test('empty input → null', () => {
  assert.equal(computeRiskStats([]), null);
  assert.equal(computeRiskStats(null), null);
});

test('win rate is decisive-only (invalid/neutral excluded)', () => {
  const st = computeRiskStats(rows([
    ['win', 3, 50], ['loss', -2, 40], ['invalid', null, 30], ['neutral', -1.5, 20], ['win', 4, 10],
  ]));
  assert.equal(st.sample_size, 5);
  assert.equal(st.wins, 2);
  assert.equal(st.losses, 1);
  assert.equal(st.neutral, 2);                    // neutral + invalid bucket
  assert.ok(Math.abs(st.win_rate - 2 / 3) < 0.001);
});

test('expectancy and profit factor', () => {
  const st = computeRiskStats(rows([
    ['win', 10, 40], ['win', 5, 30], ['loss', -5, 20], ['loss', -5, 10],
  ]));
  assert.equal(st.expectancy_bps, 1.25);          // (10+5−5−5)/4
  assert.equal(st.profit_factor, 1.5);            // 15/10
  assert.equal(st.net_return_bps, 5);
});

test('profit factor null when no wins', () => {
  const st = computeRiskStats(rows([['loss', -5, 10], ['loss', -3, 5]]));
  assert.equal(st.profit_factor, 0);              // grossLoss>0, grossWin=0 → 0
});

test('max drawdown from equity curve', () => {
  const st = computeRiskStats(rows([
    ['win', 10, 60], ['win', 10, 50],             // equity 20 (peak)
    ['loss', -6, 40], ['loss', -6, 30],           // equity 8  → dd 12
    ['win', 2, 20], ['loss', -1, 10],             // equity 9
  ]));
  assert.equal(st.max_drawdown_bps, 12);
});

test('losing streaks: current and max, reset by a win', () => {
  const st = computeRiskStats(rows([
    ['loss', -1, 60], ['loss', -1, 50], ['loss', -1, 40],   // streak 3
    ['win', 2, 30],                                          // reset
    ['loss', -1, 20], ['loss', -1, 10],                      // current streak 2
  ]));
  assert.equal(st.max_losing_streak, 3);
  assert.equal(st.current_losing_streak, 2);
});

test('rows are sorted by evaluated_at regardless of input order', () => {
  const st = computeRiskStats(rows([
    ['win', 3, 1], ['loss', -2, 100], ['loss', -2, 50],
  ]));
  // chronological: loss(100m ago), loss(50m), win(1m) → current streak 0
  assert.equal(st.current_losing_streak, 0);
  assert.equal(st.max_losing_streak, 2);
});

test('breakeven rows count but stay out of win rate', () => {
  const st = computeRiskStats(rows([
    ['win', 3, 30], ['breakeven', 0, 20], ['loss', -3, 10],
  ]));
  assert.equal(st.breakeven, 1);
  assert.equal(st.win_rate, 0.5);
});
