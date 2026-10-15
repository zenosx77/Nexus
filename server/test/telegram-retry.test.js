import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TELEGRAM_MAIN_CHAT = 'offline-private-main';
const { runTelegramRetries } = await import('../src/telegram.js');
const now = Date.parse('2026-10-15T12:00:00Z');
const row = (id, extra = {}) => ({ id, chat_id: 'main', payload: 'hello', status: 'failed', attempts: 1,
  server_managed: true, message_kind: 'other', first_attempt_at: new Date(now - 120000).toISOString(), ...extra });
function fixture(rows, error = null) {
  const operations = [], updates = [], sends = [];
  const query = {};
  for (const method of ['select', 'eq', 'in', 'lt', 'order']) query[method] = (...args) => { operations.push([method, ...args]); return query; };
  query.limit = async n => { operations.push(['limit', n]); return { data: rows, error: null }; };
  const db = async () => ({ from: () => ({ ...query, update: data => ({ eq: async (_, id) => { updates.push({ id, data }); return { error }; } }) }) });
  const send = async (...args) => { sends.push(args); return { ok: true, message_id: 42 }; };
  return { db, send, now, operations, updates, sends };
}
test('offline bounded worker retry pass excludes historic rows, fresh pending and unknown destinations', async () => {
  const f = fixture([row('old', { server_managed: false }), row('fresh', { status: 'pending', first_attempt_at: new Date(now).toISOString() }),
    row('unknown', { chat_id: 'toString' }), row('send')]);
  const stats = await runTelegramRetries(f);
  assert.deepEqual(stats, { retried: 1, sent: 1, still_failing: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][0], 'offline-private-main');
  assert.ok(f.operations.some(op => op[0] === 'eq' && op[1] === 'server_managed' && op[2] === true));
  assert.ok(f.operations.some(op => op[0] === 'limit' && op[1] === 25));
  assert.equal(f.updates[0].data.status, 'skipped');
  assert.equal(f.updates[1].data.status, 'sent');
  assert.equal(f.updates[1].data.attempts, 2);
});
test('failed retry errors are redacted and retry count is bounded', async () => {
  const f = fixture([row('send', { attempts: 2 })]);
  const stats = await runTelegramRetries({ ...f, send: async () => ({ ok: false, error: 'sb_secret_FAKE_TEST_ONLY' }) });
  assert.equal(stats.still_failing, 1);
  assert.equal(f.updates[0].data.status, 'failed');
  assert.equal(f.updates[0].data.attempts, 3);
  assert.equal(f.updates[0].data.last_error.includes('sb_secret_'), false);
});
test('persistence failure stops the pass instead of falsely reporting success or sending further rows', async () => {
  const f = fixture([row('one'), row('two')], new Error('offline persistence failure'));
  await assert.rejects(runTelegramRetries(f), /persistence failed/);
  assert.equal(f.sends.length, 1);
});
