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
test('both scopes call shared account RPC with hard-capped configuration', async () => {
  const calls = [];
  const deps = { db: async () => ({ rpc: async (...args) => { calls.push(args); return { data: { guard_version:1, account:'twelvedata', daily_limit:700, minute_limit:6, valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved', allowed: true } }; } }) };
  await reserveTwelveDataCredit(deps);
  await reserveTwelveDataBrowserCredit('ticker', 999, deps);
  assert.deepEqual(calls, [
    ['reserve_twelvedata_account_credit', { p_scope: 'worker', p_daily_limit: 700, p_minute_limit: 6 }],
    ['reserve_twelvedata_account_credit', { p_scope: 'browser', p_daily_limit: 700, p_minute_limit: 6, p_category: 'ticker', p_scan_reserve: 6 }],
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
    db: async () => ({ rpc: async () => { order.push('reserve'); return { data: [{ guard_version:1, account:'twelvedata', daily_limit:700, minute_limit:6, valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved', allowed: true }] }; } }),
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
    db: async () => ({ rpc: async () => { order.push('reserve'); return { data: { guard_version:1, account:'twelvedata', daily_limit:700, minute_limit:6, valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved', allowed: true } }; } }),
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

test('old guard, malformed replies, thrown RPC and ambiguous slow commits never reach provider', async () => {
  const good = {guard_version:1, account:'twelvedata', daily_limit:700, minute_limit:6, valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved', allowed:true};
  for (const response of [{allowed:true}, {...good, guard_version:0}, {...good, daily_limit:1400},
    {...good, valid_for_ms:0}, {...good, valid_for_ms:1001}, [good,good], {...good,account:'key-2'}]) {
    reset();
    await assert.rejects(requestTwelveData('price', {symbol:'EUR/USD'}, 'browser', {}, {
      db:async()=>({rpc:async()=>({data:response})}),
      fetch:async()=>assert.fail('must not fetch'),
    }), e=>e.reason==='guard-unavailable');
  }
  reset();let tick=0;
  await assert.rejects(requestTwelveData('price', {symbol:'EUR/USD'}, 'worker', {}, {
    db:async()=>({rpc:async()=>({data:good})}), monotonicNow:()=>tick++*1000,
    fetch:async()=>assert.fail('expired permit must not dispatch'),
  }), e=>e.reason==='guard-unavailable');
  reset();
  await assert.rejects(requestTwelveData('price', {symbol:'EUR/USD'}, 'browser', {}, {
    db:async()=>({rpc:async()=>{throw new Error('sensitive database response');}}),
    fetch:async()=>assert.fail('must not fetch'),
  }), e=>e.reason==='guard-unavailable' && !e.message.includes('sensitive'));
});

test('quota denial during key failover stops additional paid calls', async () => {
  reset();let reservations=0, fetches=0;
  const contract={guard_version:1,account:'twelvedata',daily_limit:700,minute_limit:6,valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved'};
  await assert.rejects(requestTwelveData('price', {symbol:'EUR/USD'}, 'worker', {}, {
    db:async()=>({rpc:async()=>({data:++reservations===1 ? {...contract,allowed:true} : {...contract,allowed:false,reason:'minute-limit'}})}),
    fetch:async()=>{fetches++;return {ok:false,status:503,json:async()=>({})};},
  }), e=>e.reason==='minute-limit');
  assert.equal(fetches,1);assert.equal(reservations,2);
});

test('permit freshness is rechecked at dispatch after promise continuation delay',async()=>{
  reset();const times=[0,0,1001];
  await assert.rejects(requestTwelveData('price',{symbol:'EUR/USD'},'browser',{}, {
    db:async()=>({rpc:async()=>({data:{allowed:true,guard_version:1,account:'twelvedata',daily_limit:700,minute_limit:6,valid_for_ms:1000,daily_calls:1,minute_calls:1,reason:'reserved'}})}),
    monotonicNow:()=>times.shift(),fetch:async()=>assert.fail('late dispatch must fail closed'),
  }),e=>e.reason==='guard-unavailable');
  assert.equal(times.length,0);
});

test('provider redirects cannot cause unreserved requests across scopes or key failovers', async t => {
  const { createServer } = await import('node:http');
  const nativeFetch = globalThis.fetch;
  let status = 302, initialRequests = 0, redirectedRequests = 0, reservations = 0;
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      initialRequests++;
      res.writeHead(status, { location: '/unexpected-paid-request' });
      res.end();
    } else {
      redirectedRequests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ price: '1.1' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const localUrl = `http://127.0.0.1:${server.address().port}/start`;
  const deps = {
    db: async () => ({ rpc: async () => {
      reservations++;
      return { data: { allowed: true, guard_version: 1, account: 'twelvedata',
        daily_limit: 700, minute_limit: 6, valid_for_ms: 1000,
        daily_calls: 1, minute_calls: 1, reason: 'reserved' } };
    } }),
    // Keep the native fetch redirect behavior; map only the origin to a local fixture.
    fetch: (_url, options) => nativeFetch(localUrl, options),
  };
  for (const scope of ['worker', 'browser']) {
    for (status of [301, 302, 303, 307, 308]) {
      reset(); initialRequests = redirectedRequests = reservations = 0;
      await assert.rejects(requestTwelveData('price', { symbol: 'EUR/USD' }, scope, {}, deps), /provider unavailable/);
      assert.equal(initialRequests, config.twelveDataKeys.length, 'each explicit failover is bounded');
      assert.equal(reservations, initialRequests, 'every dispatched attempt has its own reservation');
      assert.equal(redirectedRequests, 0, 'fetch must never follow an unreserved redirect');
    }
  }
  // Free usage checks must not redirect into a paid endpoint either.
  const { getTwelveDataUsage } = await import('../src/twelvedata.js');
  initialRequests = redirectedRequests = 0;
  const priorReservations = reservations;
  try {
    globalThis.fetch = deps.fetch;
    const usage = await getTwelveDataUsage();
    assert.deepEqual(usage.map(row => [row.used, row.limit, row.error]),
      config.twelveDataKeys.map(() => [null, null, 'network error']),
      'redirect rejection reports unavailable usage, never fabricated counters');
    assert.equal(initialRequests, config.twelveDataKeys.length);
    assert.equal(redirectedRequests, 0);
    assert.equal(reservations, priorReservations, 'free usage check reserves no paid credit');
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
