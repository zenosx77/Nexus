// Real loopback HTTP, fake Auth/database/provider/Bot transports only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNexusApiServer } from '../src/api.js';
import { config } from '../src/config.js';
import { TwelveDataBudgetError } from '../src/credit-budget.js';

const origin = 'https://pages.example.test';
const market = { operation: 'time_series', params: { symbol: 'EUR/USD' } };
async function fixture(t, overrides = {}) {
  const calls = { auth: [], market: [], telegram: [], inserts: [] };
  const settings = { ...config, allowedOrigins: [origin], telegramAdminUserIds: ['admin'],
    telegramBotToken: 'fake-bot', telegramChats: { main: 'fake-private-chat', admin: 'fake-admin-chat' },
    apiUserRateLimitPerMinute: 100, telegramRateLimitPerMinute: 100, cloudSyncEnabled: true };
  const server = createNexusApiServer({ config: settings,
    db: async () => ({ auth: { getUser: async token => {
      calls.auth.push(token);
      if (token === 'unavailable') throw new Error('fake auth unavailable');
      if (token === 'invalid') return { error: new Error('invalid') };
      const banned_until = token === 'banned' ? '2999-01-01T00:00:00Z' : token === 'expired-ban' ? '2000-01-01T00:00:00Z' : undefined;
      return { data: { user: { id: token, banned_until } } };
    } }, from: table => ({ insert: async row => { calls.inserts.push({ table, row }); return { error: null }; } }) }),
    requestTwelveData: async (...args) => { calls.market.push(args); return { data: { values: [] } }; },
    telegramApiCall: async (...args) => { calls.telegram.push(args); return { ok: true, result: { message_id: 42, date: 1, chat: { id: 'fake-private-chat' } } }; },
    providerStatus: () => ({ configured: true, healthy: true, keyCount: 1 }),
    getTwelveDataUsage: async () => [{ key: 'Server key 1', used: 2, limit: 700 }],
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (path = '/api/v1/market', body = market, options = {}) => {
    const { headers, ...rest } = options;
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, authorization: 'Bearer user', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), ...rest });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, headers: response.headers, data };
  };
  // Passing undefined explicitly to a default argument uses its default; GET helpers use null + method/body override.
  const get = (path, headers = {}) => request(path, null, { method: 'GET', body: undefined, headers });
  return { calls, request, get, settings };
}

test('health is public liveness only; secrets absent and no Auth/provider call', async t => {
  const f = await fixture(t);
  const r = await f.get('/api/v1/health', { origin: '', authorization: '' });
  assert.equal(r.status, 200);
  assert.equal(r.data.browserBudget.dailyLimit, 700);
  assert.equal(r.data.browserBudget.perMinuteLimit, 6);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(JSON.stringify(r.data).includes('fake-private-chat'), false);
  assert.equal(f.calls.auth.length + f.calls.market.length, 0);
});

test('CORS accepts exact origins/preflight and rejects absent, malformed and hostile origins', async t => {
  const f = await fixture(t);
  const preflight = await f.request('/api/v1/market', null, { method: 'OPTIONS', body: undefined, headers: { authorization: '' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('vary'), 'Origin');
  for (const headers of [{ 'access-control-request-method': 'DELETE' }, { 'access-control-request-headers': 'x-private-key' }]) {
    assert.equal((await f.request('/api/v1/market', null, { method: 'OPTIONS', body: undefined, headers })).status, 403);
  }
  for (const bad of ['', 'null', '*', origin + '/', origin + '/Nexus', origin + '.evil.test', 'https://user@pages.example.test']) {
    const r = await f.request('/api/v1/market', market, { headers: { origin: bad } });
    assert.equal(r.status, 403, bad);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(f.calls.auth.length, 0);
  assert.equal(f.calls.market.length, 0);
});

test('every protected route rejects missing, invalid and banned Auth before transport', async t => {
  const f = await fixture(t);
  for (const path of ['/api/v1/session', '/api/v1/usage', '/api/v1/market', '/api/v1/telegram']) {
    const isGet = /session|usage/.test(path);
    for (const authorization of ['', 'Basic user', 'Bearer invalid', 'Bearer banned']) {
      const r = isGet ? await f.get(path, { authorization }) : await f.request(path, {}, { headers: { authorization } });
      assert.equal(r.status, 401, path);
    }
  }
  assert.equal((await f.get('/api/v1/session', { authorization: 'Bearer unavailable' })).status, 503);
  assert.equal((await f.get('/api/v1/session', { authorization: 'Bearer expired-ban' })).status, 200);
  assert.equal(f.calls.market.length + f.calls.telegram.length, 0);
});

test('market validation rejects invalid JSON, shapes, types, operations and parameters', async t => {
  const f = await fixture(t);
  for (const body of ['{', 'null', '[]', '42', '"hello"', {},
    { operation: 'api_usage', params: { symbol: 'EUR/USD' } },
    { ...market, params: [] }, { ...market, params: { symbol: 'EUR/USD', apikey: 'injected' } },
    { ...market, params: { symbol: 'EUR/USD,GBP/USD' } },
    { ...market, params: { symbol: 'EUR/USD', outputsize: 5001 } },
    { ...market, params: { symbol: 'EUR/USD', interval: 'bad' } },
    { operation: 'quote', params: { symbol: 'EUR/USD', interval: 'bad' } },
    { ...market, params: { symbol: 'EUR/USD', dp: 16 } },
    { ...market, params: { symbol: 'EUR/USD', timezone: {} } }]) {
    assert.equal((await f.request('/api/v1/market', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request('/api/v1/market', market, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/v1/market', { padding: 'x'.repeat(33 * 1024) })).status, 413);
  assert.equal(f.calls.market.length, 0);
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.calls.market[0], ['time_series', { symbol: 'EUR/USD', interval: '1min', outputsize: 100 }, 'browser', { category: 'scan', scanReserve: 0 }]);
  assert.equal((await f.request('/api/v1/market', market, { method: 'PUT' })).status, 405);
  assert.equal((await f.get('/unknown')).status, 404);
});

test('per-user rate limits enforce/reset independently; usage is limited to 10/minute', async t => {
  let time = 100000;
  const f = await fixture(t, { config: { ...config, allowedOrigins: [origin], telegramAdminUserIds: ['admin'],
    telegramBotToken: 'fake', telegramChats: { main: 'private' }, apiUserRateLimitPerMinute: 2, telegramRateLimitPerMinute: 1 }, now: () => time });
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request()).status, 429);
  assert.equal((await f.request('/api/v1/market', market, { headers: { authorization: 'Bearer other' } })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await f.get('/api/v1/usage')).status, 200);
  assert.equal((await f.get('/api/v1/usage')).status, 429);
  const send = { method: 'sendMessage', channel: 'main', text: 'hello' };
  const admin = { headers: { authorization: 'Bearer admin' } };
  assert.equal((await f.request('/api/v1/telegram', send, admin)).status, 200);
  assert.equal((await f.request('/api/v1/telegram', send, admin)).status, 429);
  time += 60000;
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/api/v1/telegram', send, admin)).status, 200);
});

test('persistent guard errors return 429 and Retry-After, never a successful paid response', async t => {
  const f = await fixture(t, { requestTwelveData: async () => { throw new TwelveDataBudgetError('minute-limit', 'blocked', 1201); } });
  const r = await f.request();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '2');
  assert.equal(r.data.code, 'TWELVEDATA_BUDGET_BLOCKED');
});

test('Telegram is admin-only, resolves aliases, validates requests and records provenance', async t => {
  const f = await fixture(t);
  const admin = { headers: { authorization: 'Bearer admin' } };
  const send = { method: 'sendMessage', channel: 'main', text: 'hello', record_delivery: true };
  assert.equal((await f.request('/api/v1/telegram', send)).status, 403);
  for (const body of [{ ...send, method: 'deleteMessage' }, { ...send, channel: 'toString' },
    { ...send, channel: 'raw-private-id' }, { ...send, text: 'x'.repeat(4097) }, { ...send, text: 123 },
    { method: 'setMyCommands', commands: [{ command: 'good', description: '' }] },
    { method: 'setMyCommands', commands: Array(101).fill({ command: 'good', description: 'good' }) },
    { method: 'getUpdates', timeout: 11 }, { method: 'sendSticker', channel: 'main', sticker: {} }]) {
    assert.equal((await f.request('/api/v1/telegram', body, admin)).status, 400);
  }
  assert.equal(f.calls.telegram.length, 0);
  const r = await f.request('/api/v1/telegram', send, admin);
  assert.equal(r.status, 200);
  assert.equal(r.data.result.chat.id, 'main');
  assert.deepEqual(r.data.deliveryLog, { recorded: true });
  assert.equal(JSON.stringify(r.data).includes('fake-private-chat'), false);
  assert.equal(f.calls.telegram[0][1].chat_id, 'fake-private-chat');
  const row = f.calls.inserts[0].row;
  assert.equal(row.chat_id, 'main');
  assert.equal(row.server_managed, true);
  assert.equal(row.status, 'sent');
  assert.equal(row.telegram_message_id, '42');
  assert.equal(row.attempts, 1);
});

test('a successful send with unavailable logging is reported honestly without resending', async t => {
  const f = await fixture(t, { db: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'admin' } } }) },
    from: () => ({ insert: async () => ({ error: new Error('database unavailable') }) }) }) });
  const r = await f.request('/api/v1/telegram', { method: 'sendMessage', channel: 'main', text: 'hello', record_delivery: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.deliveryLog, { recorded: false });
  assert.equal(f.calls.telegram.length, 1);
});

test('failed sends have failed server-managed logs and sanitized error responses', async t => {
  const f = await fixture(t, { telegramApiCall: async () => ({ ok: false, error: 'failed sb_secret_FAKE_TEST_ONLY_SECRET' }) });
  const r = await f.request('/api/v1/telegram', { method: 'sendMessage', channel: 'admin', text: 'hello', record_delivery: true }, { headers: { authorization: 'Bearer admin' } });
  assert.equal(r.status, 502);
  assert.equal(JSON.stringify(r.data).includes('sb_secret_'), false);
  const row = f.calls.inserts[0].row;
  assert.equal(row.channel, 'ops');
  assert.equal(row.chat_id, 'admin');
  assert.equal(row.status, 'failed');
  assert.equal(row.sent_at, null);
  assert.equal(row.last_error.includes('sb_secret_'), false);
});

test('Telegram polling filters private destinations and strips identities/secrets', async t => {
  const f = await fixture(t, { telegramApiCall: async () => ({ ok: true, result: [
    { update_id: 1, message: { message_id: 2, chat: { id: 'fake-private-chat', type: 'channel' }, text: 'sb_secret_FAKE_TEST_ONLY', from: { id: 999, first_name: 'test' } } },
    { update_id: 2, message: { chat: { id: 'unconfigured' }, text: 'private unrelated text' } },
  ] }) });
  const r = await f.request('/api/v1/telegram', { method: 'getUpdates' }, { headers: { authorization: 'Bearer admin' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.result[0].message.chat.id, 'main');
  assert.equal(r.data.result[0].message.from.id, undefined);
  assert.equal(r.data.result[1].message, undefined);
  assert.equal(/fake-private-chat|unconfigured|sb_secret_|private unrelated/.test(JSON.stringify(r.data)), false);
});
