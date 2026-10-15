// Twelve Data worker budget math (pure logic; no Supabase or provider calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_INGEST_BUDGET_SHARE, TwelveDataBudgetError,
  ingestBatchSize, nextUtcMidnightMs, recommendedIngestIntervalSeconds,
} from '../src/credit-budget.js';

test('live ingestion only spends 80% of the daily request limit', () => {
  assert.equal(LIVE_INGEST_BUDGET_SHARE, 0.8);
  assert.equal(recommendedIngestIntervalSeconds(1, 700, 6, 60), 155);
  assert.equal(recommendedIngestIntervalSeconds(10, 700, 6, 60), 926);
});

test('live ingestion batches respect the per-minute cap and rotate large watchlists', () => {
  assert.equal(ingestBatchSize(10, 6), 6);
  assert.equal(ingestBatchSize(3, 6), 3);
  assert.equal(ingestBatchSize(10, 0), 0);
  assert.equal(recommendedIngestIntervalSeconds(10, 700, 1, 60), 155);
});

test('zero daily budget disables live ingestion and a larger configured minimum wins', () => {
  assert.equal(recommendedIngestIntervalSeconds(10, 0, 6, 60), Infinity);
  assert.equal(recommendedIngestIntervalSeconds(1, 700, 6, 300), 300);
});

test('UTC daily budget rollover computes the next UTC midnight', () => {
  const now = Date.parse('2026-10-15T13:45:00Z');
  assert.equal(new Date(nextUtcMidnightMs(now)).toISOString(), '2026-10-16T00:00:00.000Z');
});

test('budget blocks are distinguishable from provider failures', () => {
  const err = new TwelveDataBudgetError('minute-limit', 'rate budget reached', 12_000);
  assert.equal(err.code, 'TWELVEDATA_BUDGET_BLOCKED');
  assert.equal(err.reason, 'minute-limit');
  assert.equal(err.retryAfterMs, 12_000);
});
