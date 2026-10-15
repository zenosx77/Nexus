// Disposable real-process fixture. No provider transport or production SQL.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const connectionString = process.env.NEXUS_TEST_POSTGRES_URL;
const url = new URL(connectionString);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || decodeURIComponent(url.hostname) === require('node:path').resolve('.cache'));
assert.equal(url.pathname, '/nexus_quota_test');
assert.equal(url.search, '');
const [scope, mode = 'normal'] = process.argv.slice(2);
assert.ok(['worker', 'browser'].includes(scope));
assert.ok(['normal', 'crash', 'lost-response', 'failover', 'network-retry'].includes(mode));
process.env.TWELVEDATA_KEYS = 'offline-process-key-one,offline-process-key-two';
(async () => {
  const client = new Client({ connectionString });
  await client.connect();
  const { requestTwelveData } = await import('../../server/src/twelvedata.js');
  let rpcCalls = 0, granted = 0, paid = 0;
  let ok = false, reason = null, expired = false;
  try {
    await requestTwelveData('price', { symbol: 'EUR/USD' }, scope, {}, {
      db: async () => ({ rpc: async (name, p) => {
        assert.equal(name, 'reserve_twelvedata_account_credit');
        rpcCalls++;
        const result = await client.query('select reserve_twelvedata_account_credit($1,$2,$3,$4,$5) as result',
          [p.p_scope, p.p_daily_limit, p.p_minute_limit, p.p_category ?? 'scan', p.p_scan_reserve ?? 0]);
        if (result.rows[0].result.allowed) granted++;
        // Standalone SQL has COMMITTED before the child dies or the reply is lost.
        if (mode === 'crash') process.exit(23);
        if (mode === 'lost-response') throw new Error('simulated lost reservation reply');
        return { data: result.rows[0].result };
      } }),
      fetch: async () => {
        paid++;
        if (mode === 'network-retry' && paid === 1) throw new Error('simulated network failure');
        return mode === 'failover' && paid === 1
          ? { ok: false, status: 503, json: async () => ({}) }
          : { ok: true, json: async () => ({ price: '1.1' }) };
      },
    });
    ok = true;
  } catch (error) {
    if (error.code !== 'TWELVEDATA_BUDGET_BLOCKED') throw error;
    reason = error.reason;
    expired = /expired/.test(error.message);
  } finally {
    await client.end();
  }
  console.log(JSON.stringify({ ok, reason, expired, rpcCalls, granted, paid }));
})().catch(() => {
  console.error('disposable quota process fixture failed');
  process.exitCode = 1;
});
