'use strict';
// Hosted smoke checks. Never log response bodies, keys, JWTs, IDs or prices.
// Default: one anonymous Auth signup + logout, GETs/preflight only; no trading
// records, quota reservations, model changes, polling or Telegram messages.
const fs = require('node:fs');
const PROJECT = 'rxswndsebvaqztshbmlc';
const BASE = `https://${PROJECT}.supabase.co`;
const API = `${BASE}/functions/v1/nexus-relay/api/v1`;
const ORIGIN = 'https://zenosx77.github.io';
// Safety check only, NOT JWT authentication: the live services validate it.
// This client uses the legacy public anon JWT for REST Authorization, matching
// the website. Refuse privileged/wrong-project keys before any network request.
function assertAnonKey(key) {
  let payload;
  try { payload = JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url').toString()); } catch { /* reject below */ }
  if (payload?.role !== 'anon' || payload?.ref !== PROJECT) throw new Error("Use this project's legacy public anon JWT, never a private key");
}
async function resolveAnonKey(env = process.env, fetcher = fetch) {
  if (env.SUPABASE_ANON_KEY?.trim()) return env;
  if (env.SUPABASE_PROJECT_REF !== PROJECT || !env.SUPABASE_ACCESS_TOKEN?.trim()) return env;
  try {
    const res = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    });
    if (!res.ok) return env;
    const keys = await res.json();
    if (!Array.isArray(keys)) return env;
    const anon = keys.find(k => {
      if (typeof k?.api_key !== 'string') return false;
      try { assertAnonKey(k.api_key); return true; } catch { return false; }
    });
    if (!anon) return env;
    if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${anon.api_key}`);
    return { ...env, SUPABASE_ANON_KEY: anon.api_key };
  } catch {
    return env;
  }
}
async function verify(env = process.env, fetcher = fetch) {
  if (env.SUPABASE_PROJECT_REF !== PROJECT || env.NEXUS_ALLOWED_ORIGINS !== ORIGIN) throw new Error('Production target/origin mismatch');
  if (!env.SUPABASE_ANON_KEY?.trim()) throw new Error('Missing SUPABASE_ANON_KEY');
  const key = env.SUPABASE_ANON_KEY;
  assertAnonKey(key);
  const results = [];
  const check = (ok) => { if (!ok) throw new Error('Check failed'); };
  async function request(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    let body = null;
    try { body = await response.json(); } catch { /* fixed diagnostics only */ }
    return { response, body };
  }
  async function step(name, action) {
    try { await action(); results.push({ name, status: 'PASS' }); return true; }
    catch { results.push({ name, status: 'FAIL' }); return false; }
  }
  function skip(name) { results.push({ name, status: 'SKIP' }); }
  function relayHeaders(token) {
    return { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }
  await step('Health and exact production CORS', async () => {
    const { response, body } = await request(`${API}/health`, { headers: relayHeaders() });
    check(response.status === 200 && body?.ok === true && body.service === 'nexus-api');
    check(response.headers.get('access-control-allow-origin') === ORIGIN);
  });
  await step('Browser preflight', async () => {
    const { response } = await request(`${API}/session`, { method: 'OPTIONS', headers: {
      origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type',
    } });
    check(response.status === 204 && response.headers.get('access-control-allow-origin') === ORIGIN);
  });
  for (const [name, token] of [['Missing bearer rejected by application', ''], ['Invalid bearer rejected by application', 'invalid-nexus-test-token']]) {
    await step(name, async () => {
      const { response, body } = await request(`${API}/session`, { headers: relayHeaders(token) });
      check(response.status === 401 && body?.error === 'A valid NEXUS session is required');
    });
  }
  await step('Disallowed origin rejected', async () => {
    const { response } = await request(`${API}/session`, { headers: { origin: 'https://nexus-test.invalid' } });
    check(response.status === 403 && !response.headers.has('access-control-allow-origin'));
  });
  const readPaths = ['currency_pairs?select=code&limit=1', 'model_versions?select=id&limit=1',
    'risk_snapshots?select=scope&limit=1', 'v_market_freshness?select=pair&limit=1',
    'v_deliveries_public?select=status&limit=1', 'v_ingestion_health_public?select=status&limit=1'];
  await step('Public Cloud Sync database reads (no writes)', async () => {
    for (const path of readPaths) {
      const { response, body } = await request(`${BASE}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
      check(response.status === 200 && Array.isArray(body));
      if (path.startsWith('currency_pairs')) check(body.length > 0 && typeof body[0].code === 'string');
    }
  });
  let token;
  let userId;
  const signedIn = await step('Anonymous Auth sign-in', async () => {
    const { response, body } = await request(`${BASE}/auth/v1/signup`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: '{}' });
    // Retain a token even for a malformed reply so logout is still attempted.
    token = body?.access_token;
    userId = body?.user?.id;
    check(response.status === 200 && typeof token === 'string' && typeof userId === 'string' && body?.user?.is_anonymous === true);
  });
  try {
    const sessionOk = signedIn && await step('Actual authenticated GET /api/v1/session', async () => {
      const { response, body } = await request(`${API}/session`, { headers: relayHeaders(token) });
      check(response.status === 200 && body?.ok === true && body.userId === userId);
      check(body.cloudSyncEnabled === true && body.modelSyncEnabled === true);
      check(response.headers.get('access-control-allow-origin') === ORIGIN);
    });
    if (!signedIn) skip('Actual authenticated GET /api/v1/session');
    if (signedIn) {
      await step('Authenticated database read', async () => {
        const { response, body } = await request(`${BASE}/rest/v1/currency_pairs?select=code&limit=1`, { headers: { apikey: key, authorization: `Bearer ${token}` } });
        check(response.status === 200 && Array.isArray(body) && body.length > 0);
      });
    } else skip('Authenticated database read');
    if (sessionOk) {
      await step('Twelve Data relay free usage lookup', async () => {
        const { response, body } = await request(`${API}/usage`, { headers: relayHeaders(token) });
        check(response.status === 200 && Array.isArray(body?.keys) && body.keys.length > 0);
        check(body.keys.every(k => k.error === null && Number.isFinite(k.used) && Number.isFinite(k.limit)));
      });
    } else skip('Twelve Data relay free usage lookup');
    if (sessionOk && env.NEXUS_VERIFY_MARKET === 'true') {
      await step('Twelve Data relay price (one request, quota enforced)', async () => {
        const { response, body } = await request(`${API}/market`, { method: 'POST', headers: { ...relayHeaders(token), 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'price', params: { symbol: 'EUR/USD' }, category: 'ticker' }) });
        check(response.status === 200 && Number(body?.data?.price) > 0);
      });
    } else skip('Twelve Data relay price (one request, quota enforced)');
    if (sessionOk && env.NEXUS_VERIFY_TELEGRAM === 'true') {
      await step('Telegram private admin test delivery (not a trading signal)', async () => {
        check(Boolean(env.TELEGRAM_ADMIN_CHAT?.trim() && env.NEXUS_VERIFY_ADMIN_ACCESS_TOKEN?.trim()));
        const adminToken = env.NEXUS_VERIFY_ADMIN_ACCESS_TOKEN;
        const admin = await request(`${API}/session`, { headers: relayHeaders(adminToken) });
        check(admin.response.status === 200 && admin.body?.telegramAdmin === true && admin.body?.telegramChannels?.admin === true);
        const { response, body } = await request(`${API}/telegram`, { method: 'POST', headers: { ...relayHeaders(adminToken), 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'sendMessage', channel: 'admin', text: 'NEXUS DEPLOYMENT TEST — connectivity check only. NOT A TRADING SIGNAL. No trade or action required.', protect_content: true, record_delivery: false }) });
        check(response.status === 200 && body?.ok === true && Number(body?.result?.message_id) > 0);
      });
    } else skip('Telegram private admin test delivery (not a trading signal)');
  } finally {
    if (token) await step('Sign out verification session', async () => {
      const { response } = await request(`${BASE}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${token}` } });
      check(response.status === 204);
    });
  }
  return results;
}
module.exports = { verify, assertAnonKey, resolveAnonKey, PROJECT, BASE, API, ORIGIN };
if (require.main === module) {
  resolveAnonKey(process.env).then(resolvedEnv => verify(resolvedEnv)).then(results => {
    const report = results.map(r => `${r.status}: ${r.name}`).join('\n');
    const inline = results.map(r => `${r.status}: ${r.name}`).join(' | ');
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Production relay verification\n\n\`\`\`text\n${report}\n\`\`\`\n`);
    const hasFailed = results.some(r => r.status === 'FAIL');
    if (process.env.GITHUB_ACTIONS === 'true') {
      console[hasFailed ? 'error' : 'log'](`::${hasFailed ? 'error' : 'notice'} title=NEXUS Relay Verification::${inline}`);
    }
    if (hasFailed) process.exitCode = 1;
  }).catch(() => {
    const msg = 'Verification configuration invalid; check required project, origin and anon key settings.';
    console.error(msg);
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=NEXUS Relay Verification::${msg}`);
    process.exitCode = 1;
  });
}
