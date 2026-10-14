// candle validation + gap detection tests (pure logic)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandle, detectGaps, classifyAgainstStored, parseTs, MINUTE_MS } from '../src/validate.js';

const NOW = Date.UTC(2026, 9, 14, 10, 30, 0);      // 2026-10-14 10:30:00Z

function candleAt(minuteOffset, overrides = {}) {
  // candle whose OPEN time is NOW + minuteOffset minutes
  const ts = NOW + minuteOffset * MINUTE_MS;
  const dt = new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
  const o = 1.0850, c = 1.0852, h = 1.0853, l = 1.0849;
  return { datetime: dt, open: o, high: h, low: l, close: c, ...overrides };
}

test('validateCandle accepts a completed minute candle', () => {
  const r = validateCandle(candleAt(-5), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.ts % MINUTE_MS, 0);
  assert.equal(r.open, 1.0850);
});

test('validateCandle rejects the still-forming candle', () => {
  // candle opening at 10:29 (closes 10:30) evaluated at 10:30:00 — exactly due
  const r = validateCandle(candleAt(0), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'still-forming');
});

test('validateCandle rejects future timestamps', () => {
  const r = validateCandle(candleAt(5), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.reason, /future|forming/);
});

test('validateCandle rejects inconsistent OHLC', () => {
  const r = validateCandle(candleAt(-5, { high: 1.0, low: 2.0 }), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ohlc-inconsistent');
});

test('validateCandle rejects non-positive prices', () => {
  const r = validateCandle(candleAt(-5, { close: -1 }), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-prices');
});

test('validateCandle rejects non-minute-aligned timestamps', () => {
  const r = validateCandle({ ...candleAt(-5), datetime: '2026-10-14 10:25:30' }, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-minute-aligned');
});

test('validateCandle rejects unparseable datetime', () => {
  const r = validateCandle({ ...candleAt(-5), datetime: 'nope' }, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable-datetime');
});

test('validateCandle handles missing volume', () => {
  const r = validateCandle({ ...candleAt(-5), volume: null }, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.volume, null);
});

test('parseTs handles both provider formats identically', () => {
  const a = parseTs('2026-10-14 10:25:00');
  const b = Date.parse('2026-10-14T10:25:00Z');
  assert.equal(a, b);
});

test('detectGaps finds a 3-minute hole', () => {
  const t0 = NOW - 10 * MINUTE_MS;
  const present = [-10, -9, -8, -4, -3, -2, -1].map(m => t0 + (m + 10) * MINUTE_MS);
  const gaps = detectGaps(present, t0, t0 + 9 * MINUTE_MS);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].count, 3);
});

test('detectGaps returns empty for a continuous series', () => {
  const t0 = NOW - 5 * MINUTE_MS;
  const present = [0, 1, 2, 3, 4].map(i => t0 + i * MINUTE_MS);
  assert.deepEqual(detectGaps(present, t0, t0 + 4 * MINUTE_MS), []);
});

test('detectGaps reports a trailing gap up to the bound', () => {
  const t0 = NOW - 5 * MINUTE_MS;
  const present = [0, 1, 2].map(i => t0 + i * MINUTE_MS);
  const gaps = detectGaps(present, t0, t0 + 4 * MINUTE_MS);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].count, 2);
});

test('classifyAgainstStored: new, duplicate, revised', () => {
  const incoming = { ts: 1, open: 1.1, high: 1.2, low: 1.0, close: 1.15 };
  assert.equal(classifyAgainstStored(incoming, null), 'new');
  assert.equal(classifyAgainstStored(incoming, { open: 1.1, high: 1.2, low: 1.0, close: 1.15 }), 'duplicate');
  assert.equal(classifyAgainstStored(incoming, { open: 1.1, high: 1.2, low: 1.0, close: 1.16 }), 'revised');
});

test('duplicate detection tolerates numeric-string storage round-trip', () => {
  const incoming = { ts: 1, open: 1.1, high: 1.2, low: 1.0, close: 1.15 };
  // numeric(12,7) columns come back as strings like "1.1000000"
  assert.equal(classifyAgainstStored(incoming, {
    open: '1.1000000', high: '1.2000000', low: '1.0000000', close: '1.1500000',
  }), 'duplicate');
});
