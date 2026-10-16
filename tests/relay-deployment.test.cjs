'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { configuration } = require('../tools/deploy-relay.cjs');
const { verify } = require('../tools/verify-relay.cjs');
const { verifyDatabase, FILES } = require('../tools/verify-relay-database.cjs');
const env = { SUPABASE_PROJECT_REF: 'rxswndsebvaqztshbmlc', NEXUS_ALLOWED_ORIGINS: 'https://zenosx77.github.io',
  SUPABASE_ACCESS_TOKEN: 'synthetic-management-token', SUPABASE_ANON_KEY: ['synthetic', Buffer.from(JSON.stringify({ role: 'anon', ref: 'rxswndsebvaqztshbmlc' })).toString('base64url'), 'synthetic'].join('.') };
function transport(options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    const reply = (status, body, cors = true) => new Response(status === 204 ? null : JSON.stringify(body), {
      status, headers: cors ? { 'access-control-allow-origin': env.NEXUS_ALLOWED_ORIGINS } : {},
    });
    if (path.endsWith('/health')) return reply(200, { ok: true, service: 'nexus-api' });
    if (path.endsWith('/session')) {
      if (init.method === 'OPTIONS') return reply(204);
      if (headers.get('origin') !== env.NEXUS_ALLOWED_ORIGINS) return reply(403, {}, false);
      const bearer = headers.get('authorization');
      if (!bearer || bearer.includes('invalid-')) return reply(401, { error: 'A valid NEXUS session is required' });
      if (options.sessionFail) return reply(401, {});
      return reply(200, { ok: true, userId: options.wrongUser ? 'wrong' : 'smoke-user', cloudSyncEnabled: true, modelSyncEnabled: true,
        telegramAdmin: bearer === 'Bearer synthetic-admin', telegramChannels: { admin: true } });
    }
    if (path.includes('/rest/v1/')) return reply(200, path.endsWith('/currency_pairs') ? [{ code: 'EUR/USD' }] : []);
    if (path.endsWith('/signup')) return reply(options.signupFail ? 400 : 200, options.signupFail ? {} : { access_token: 'synthetic-session', user: { id: 'smoke-user', is_anonymous: true } });
    if (path.endsWith('/logout')) return reply(204);
    if (path.endsWith('/usage')) return reply(200, { keys: options.noKeys ? [] : [{ error: null, used: 0, limit: 700 }] });
    if (path.endsWith('/market')) return reply(options.quotaBlocked ? 429 : 200, { data: { price: '1.08' } });
    if (path.endsWith('/telegram')) return reply(200, { ok: true, result: { message_id: 1 } });
    throw new Error('Unexpected request');
  };
  return { calls, fetcher };
}
test('deployment target is fixed; missing credentials, dotenv injection and unsafe private tests fail before CLI', () => {
  assert.deepEqual(configuration(env), { NEXUS_ALLOWED_ORIGINS: env.NEXUS_ALLOWED_ORIGINS });
  for (const patch of [{ SUPABASE_PROJECT_REF: 'other' }, { NEXUS_ALLOWED_ORIGINS: '*' }, { SUPABASE_ACCESS_TOKEN: '' },
    { SUPABASE_ANON_KEY: '' }, { SUPABASE_ANON_KEY: 'sb_secret_not-a-public-key' }, { TWELVEDATA_KEYS: 'key\nINJECTED=value' }, { TELEGRAM_MAIN_CHAT: 'chat #comment' },
    { NEXUS_VERIFY_TELEGRAM: 'true' }]) assert.throws(() => configuration({ ...env, ...patch }));
  assert.equal(configuration({ ...env, TWELVEDATA_KEYS: '', TELEGRAM_ADMIN_CHAT: '-100000' }).TELEGRAM_ADMIN_CHAT, '-100000');
  const source = fs.readFileSync('tools/deploy-relay.cjs', 'utf8');
  assert.match(source, /mode: 0o600/);
  assert.match(source, /finally/);
  assert.doesNotMatch(source, /console\.(?:log|error)\(result\.(?:stdout|stderr)/);
});
test('default verification proves actual Auth identity and Cloud reads without paid calls or messages', async () => {
  const { calls, fetcher } = transport();
  const results = await verify(env, fetcher);
  assert.equal(results.filter(r => r.status === 'FAIL').length, 0);
  assert.equal(results.filter(r => r.status === 'SKIP').length, 2);
  assert.ok(results.some(r => r.name.includes('authenticated GET') && r.status === 'PASS'));
  assert.ok(calls.some(c => c.url.endsWith('/usage')));
  assert.ok(calls.some(c => c.url.includes('/logout?scope=local')));
  assert.ok(!calls.some(c => /\/(market|telegram)$/.test(c.url)));
  for (const call of calls.filter(c => c.url.includes('/rest/v1/'))) assert.equal(call.init.method, undefined);
  assert.ok(!JSON.stringify(results).includes('synthetic-session'));
});
test('failed session blocks all provider and message tests, but still signs out', async () => {
  for (const opt of [{ sessionFail: true }, { wrongUser: true }]) {
    const { calls, fetcher } = transport(opt);
    const results = await verify({ ...env, NEXUS_VERIFY_MARKET: 'true', NEXUS_VERIFY_TELEGRAM: 'true' }, fetcher);
    assert.ok(results.some(r => r.name.includes('authenticated GET') && r.status === 'FAIL'));
    assert.ok(!calls.some(c => /\/(usage|market|telegram)$/.test(c.url)));
    assert.ok(calls.some(c => c.url.includes('/logout?scope=local')));
  }
});
test('signup failure is reported honestly; free usage must return a configured successful key', async () => {
  for (const opt of [{ signupFail: true }, { noKeys: true }]) {
    const { fetcher } = transport(opt);
    const results = await verify(env, fetcher);
    assert.ok(results.some(r => r.status === 'FAIL'));
  }
});
test('opt-in market verification does not retry or bypass a denied shared quota', async () => {
  const { calls, fetcher } = transport({ quotaBlocked: true });
  const results = await verify({ ...env, NEXUS_VERIFY_MARKET: 'true' }, fetcher);
  assert.equal(calls.filter(c => c.url.endsWith('/market')).length, 1);
  assert.ok(results.some(r => r.name.includes('relay price') && r.status === 'FAIL'));
  assert.ok(calls.some(c => c.url.includes('/logout?scope=local')));
});
test('Telegram test requires explicit private destination and admin bearer, never records/retries signals', async () => {
  const blocked = transport();
  const results = await verify({ ...env, NEXUS_VERIFY_TELEGRAM: 'true' }, blocked.fetcher);
  assert.ok(results.some(r => r.name.startsWith('Telegram') && r.status === 'FAIL'));
  assert.ok(!blocked.calls.some(c => c.url.endsWith('/telegram')));
  const allowed = transport();
  const success = await verify({ ...env, NEXUS_VERIFY_TELEGRAM: 'true', TELEGRAM_ADMIN_CHAT: '-100000', NEXUS_VERIFY_ADMIN_ACCESS_TOKEN: 'synthetic-admin' }, allowed.fetcher);
  assert.ok(success.some(r => r.name.startsWith('Telegram') && r.status === 'PASS'));
  const sends = allowed.calls.filter(c => c.url.endsWith('/telegram'));
  assert.equal(sends.length, 1);
  const body = JSON.parse(sends[0].init.body);
  assert.equal(body.channel, 'admin');
  assert.equal(body.record_delivery, false);
  assert.match(body.text, /NOT A TRADING SIGNAL/);
});
test('database checks use fixed read-only SQL, never log results, fail closed on management errors', async () => {
  const calls = [];
  await verifyDatabase(env, async (url, init) => {
    calls.push(url);
    const body = JSON.parse(init.body);
    assert.equal(body.read_only, true);
    assert.match(body.query, /begin transaction read only;/i);
    assert.match(body.query, /(?:rollback|commit);/i);
    assert.equal(init.redirect, 'error');
    return new Response('[]', { status: 200 });
  });
  assert.equal(calls.length, FILES.length);
  await assert.rejects(
    verifyDatabase(env, async () => new Response('{"message":"Forbidden secret-value"}', { status: 403 })),
    err => {
      assert.match(err.message, /FAIL: supabase\/verify\/0008_read_only\.sql/);
      assert.match(err.message, /Supabase Management API rejected SUPABASE_ACCESS_TOKEN/);
      assert.doesNotMatch(err.message, /secret-value/);
      return true;
    },
  );
  let step = 0;
  await assert.rejects(
    verifyDatabase(env, async () => {
      step += 1;
      if (step === 1) return new Response('[]', { status: 200 });
      return new Response('{"message":"ERROR: 0009 missing: shared account quota migration 0009_shared_account_quota.sql is not applied (sensitive-detail)"}', { status: 400 });
    }),
    err => {
      assert.match(err.message, /FAIL: supabase\/verify\/0009_read_only\.sql/);
      assert.match(err.message, /migration 0009_shared_account_quota\.sql is not applied/);
      assert.doesNotMatch(err.message, /sensitive-detail/);
      return true;
    },
  );
});
test('relay workflow is pinned, main-only, gated, environment-scoped and verifies before deployment', () => {
  const source = fs.readFileSync('.github/workflows/deploy-relay.yml', 'utf8');
  for (const [, ref] of source.matchAll(/uses: ([^\s]+)/g)) assert.match(ref, /@[a-f0-9]{40}$/);
  assert.match(source, /github.ref == 'refs\/heads\/main'/);
  assert.match(source, /vars.NEXUS_RELAY_DEPLOY_ENABLED == 'true'/);
  assert.match(source, /environment: supabase-production/);
  assert.match(source, /contents: read/);
  assert.match(source, /cancel-in-progress: false/);
  assert.doesNotMatch(source, /pull_request|db push|db reset|--no-verify-jwt|write-all|SERVICE_ROLE/);
  assert.ok(source.indexOf('run: npm test') < source.indexOf('run: node tools/deploy-relay.cjs'));
  assert.ok(source.indexOf('run: node tools/verify-relay-database.cjs') < source.indexOf('run: node tools/deploy-relay.cjs'));
  assert.ok(source.indexOf('run: node tools/deploy-relay.cjs') < source.indexOf('run: node tools/verify-relay.cjs'));
});
