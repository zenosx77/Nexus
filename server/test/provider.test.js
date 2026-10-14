// provider health + normalisation tests (pure logic — no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerHealth, markKeyFailure, markKeySuccess, providerHealthy, normaliseAndValidate } from '../src/ingest.js';

const K1 = 'test-key-1', K2 = 'test-key-2';

function resetHealth() {
  for (const k of Object.keys(providerHealth)) delete providerHealth[k];
}

test('healthy by default once a key exists', () => {
  resetHealth();
  markKeySuccess(K1);
  assert.equal(providerHealthy(), true);
});

test('failure puts a key on cooldown with escalating backoff', () => {
  resetHealth();
  markKeyFailure(K1, new Error('boom'));
  const st = providerHealth[K1];
  assert.equal(st.ok, false);
  assert.equal(st.failures, 1);
  assert.ok(st.cooldownUntil > Date.now());
  const firstBackoff = st.cooldownUntil - Date.now();
  markKeyFailure(K1, new Error('boom again'));
  assert.ok(providerHealth[K1].cooldownUntil - Date.now() > firstBackoff);
});

test('backoff caps at 15 minutes', () => {
  resetHealth();
  for (let i = 0; i < 30; i++) markKeyFailure(K1, new Error('x'));
  assert.ok(providerHealth[K1].cooldownUntil - Date.now() <= 15 * 60_000 + 1000);
});

test('providerHealthy false when every key is cooling down', () => {
  resetHealth();
  markKeyFailure(K1, new Error('x'));
  markKeyFailure(K2, new Error('y'));
  assert.equal(providerHealthy(), false);
});

test('success clears cooldown', () => {
  resetHealth();
  markKeyFailure(K1, new Error('x'));
  markKeySuccess(K1);
  assert.equal(providerHealthy(), true);
  assert.equal(providerHealth[K1].failures, 0);
});

test('normaliseAndValidate keeps only completed candles', () => {
  const now = Date.UTC(2026, 9, 14, 10, 30, 0);
  const dt = (m) => new Date(now + m * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const okC = { datetime: dt(-5), open: 1.1, high: 1.2, low: 1.05, close: 1.15 };
  const forming = { datetime: dt(0), open: 1.1, high: 1.2, low: 1.05, close: 1.15 };
  const bad = { datetime: dt(-6), open: 1.1, high: 1.0, low: 1.05, close: 1.15 };
  const { accepted, rejected } = normaliseAndValidate([okC, forming, bad, null], now);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.includes('still-forming'));
  assert.ok(rejected.includes('ohlc-inconsistent'));
  assert.ok(rejected.includes('not-an-object'));
});
