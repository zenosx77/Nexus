// Stub only the database and provider boundaries; exercise real credit guards.
import test from 'node:test';
import assert from 'node:assert/strict';
// Fake secrets, installed before importing configuration; never real credentials.
process.env.TWELVEDATA_KEYS = 'offline-provider-fixture,offline-provider-fixture-two';
process.env.TELEGRAM_BOT_TOKEN = 'offline-bot-fixture';
process.env.TELEGRAM_MAIN_CHAT = 'offline-private-destination';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-service-fixture';
const { config, redactSecrets, log } = await import('../src/config.js');
const { reserveTwelveDataCredit, reserveTwelveDataBrowserCredit } = await import('../src/credit-budget.js');
const { requestTwelveData, providerHealth } = await import('../src/twelvedata.js');

const reset = () => { for (const key of Object.keys(providerHealth)) delete providerHealth[key]; };
test('real reservation functions use independent RPCs and preserve 700/6 and 700/7', async () => {
  const calls = [];
  const deps = { db: async () => ({ rpc: async (...args) => { calls.push(args); return { data: { allowed: true } }; } }) };
  await reserveTwelveDataCredit(deps);
  await reserveTwelveDataBrowserCredit('ticker', 999, deps);
  assert.deepEqual(calls, [
    ['reserve_twelvedata_credit', { p_daily_limit: 700, p_minute_limit: 6 }],
    ['reserve_twelvedata_browser_credit', { p_daily_limit: 700, p_minute_limit: 7, p_category: 'ticker', p_scan_reserve: 7 }],
  ]);
});

test('missing/unavailable/malformed guards fail closed before provider fetch in both scopes', async () => {
  for (const scope of ['browser', 'worker']) {
    for (const response of [{ error: { message: 'missing RPC' } }, { data: null }, { data: { allowed: 'true' } },
      { data: { allowed: false, reason: 'minute-limit', retry_after_ms: 1000 } }]) {
      reset();
      let fetches = 0;
      await assert.rejects(requestTwelveData('price', { symbol: 'EUR/USD' }, scope, {}, {
        db: async () => ({ rpc: async () => response }),
        fetch: async () => { fetches++; throw new Error('must not fetch'); },
      }), error => error.code === 'TWELVEDATA_BUDGET_BLOCKED');
      assert.equal(fetches, 0);
    }
    await assert.rejects(requestTwelveData('price', { symbol: 'EUR/USD' }, scope, {}, {
      db: async () => { throw new Error('offline'); }, fetch: async () => assert.fail('must not fetch'),
    }), error => error.reason === 'guard-unavailable');
  }
});

test('reservation precedes provider call, responses scrub credential fields and values', async () => {
  reset();
  const order = [];
  const result = await requestTwelveData('price', { symbol: 'EUR/USD' }, 'browser', {}, {
    db: async () => ({ rpc: async () => { order.push('reserve'); return { data: [{ allowed: true }] }; } }),
    fetch: async url => {
      order.push('fetch');
      assert.equal(new URL(url).searchParams.get('apikey'), config.twelveDataKeys[0]);
      return { ok: true, json: async () => ({ price: '1.1', apikey: config.twelveDataKeys[0], nested: { token: 'fake', text: config.telegramBotToken } }) };
    },
  });
  assert.deepEqual(order, ['reserve', 'fetch']);
  assert.equal(result.data.apikey, undefined);
  assert.equal(result.data.nested.token, undefined);
  assert.equal(result.data.nested.text, '[redacted]');
  assert.equal(JSON.stringify(result).includes(config.twelveDataKeys[0]), false);
});

test('logs/errors redact configured provider, Bot, destination and service-role secrets', () => {
  const secrets = [config.twelveDataKeys[0], config.telegramBotToken, config.telegramChats.main, config.supabaseServiceKey];
  const raw = secrets.join(' ') + ' sb_secret_FAKE_TEST_ONLY apikey=arbitrary-value';
  const safe = redactSecrets(raw);
  for (const secret of secrets) assert.equal(safe.includes(secret), false);
  assert.equal(safe.includes('arbitrary-value'), false);
  const lines = [];
  const original = console.log;
  try { console.log = (...args) => lines.push(args.join(' ')); log('error', raw, { error: raw }); }
  finally { console.log = original; }
  for (const secret of secrets) assert.equal(lines.join(' ').includes(secret), false);
});


test('provider failover reserves a new credit before every paid attempt; api_usage reserves none', async () => {
  reset();
  const order = [];
  let attempts = 0;
  const deps = {
    db: async () => ({ rpc: async () => { order.push('reserve'); return { data: { allowed: true } }; } }),
    fetch: async () => {
      order.push('fetch'); attempts++;
      return attempts === 1
        ? { ok: false, status: 503, json: async () => ({ message: 'offline fixture failure' }) }
        : { ok: true, json: async () => ({ price: '1.1' }) };
    },
  };
  await requestTwelveData('price', { symbol: 'EUR/USD' }, 'worker', {}, deps);
  assert.deepEqual(order, ['reserve', 'fetch', 'reserve', 'fetch']);
  order.length = 0; reset();
  await requestTwelveData('api_usage', {}, 'worker', {}, deps);
  assert.deepEqual(order, ['fetch']);
});
