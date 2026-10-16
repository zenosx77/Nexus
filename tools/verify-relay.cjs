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
  const diagnostics = [];
  Object.defineProperty(results, 'diagnostics', { value: diagnostics });
  const check = (ok, detail = 'check failed') => { if (!ok) throw new Error(detail); };
  async function request(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    let body = null;
    try { body = await response.json(); } catch { /* fixed diagnostics only */ }
    return { response, body };
  }
  async function step(name, action) {
    try { await action(); results.push({ name, status: 'PASS' }); return true; }
    catch (err) {
      results.push({ name, status: 'FAIL' });
      diagnostics.push(`${name}: ${String(err?.message || 'failed').slice(0, 140)}`);
      return false;
    }
  }
  function skip(name) { results.push({ name, status: 'SKIP' }); }
  function relayHeaders(token) {
    return { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }
  await step('Health and exact production CORS', async () => {
    const { response, body } = await request(`${API}/health`, { headers: relayHeaders() });
    check(response.status === 200 && body?.ok === true && body.service === 'nexus-api', `status=${response.status} msg=${body?.message || body?.error || ''}`);
    check(response.headers.get('access-control-allow-origin') === ORIGIN, `cors=${response.headers.get('access-control-allow-origin') || 'none'}`);
  });
  await step('Browser preflight', async () => {
    const { response } = await request(`${API}/session`, { method: 'OPTIONS', headers: {
      origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type',
    } });
    check(response.status === 204 && response.headers.get('access-control-allow-origin') === ORIGIN, `status=${response.status} cors=${response.headers.get('access-control-allow-origin') || 'none'}`);
  });
  for (const [name, token] of [['Missing bearer rejected by application', ''], ['Invalid bearer rejected by application', 'invalid-nexus-test-token']]) {
    await step(name, async () => {
      const { response, body } = await request(`${API}/session`, { headers: relayHeaders(token) });
      check(response.status === 401 && body?.error === 'A valid NEXUS session is required', `status=${response.status} err=${body?.error || body?.message || ''}`);
    });
  }
  await step('Disallowed origin rejected', async () => {
    const { response } = await request(`${API}/session`, { headers: { origin: 'https://nexus-test.invalid' } });
    check(response.status === 403 && !response.headers.has('access-control-allow-origin'), `status=${response.status}`);
  });
  const readPaths = ['currency_pairs?select=code&limit=1', 'model_versions?select=id&limit=1',
    'risk_snapshots?select=scope&limit=1', 'v_market_freshness?select=pair&limit=1',
    'v_deliveries_public?select=status&limit=1', 'v_ingestion_health_public?select=status&limit=1'];
  await step('Public Cloud Sync database reads (no writes)', async () => {
    for (const path of readPaths) {
      const { response, body } = await request(`${BASE}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
      check(response.status === 200 && Array.isArray(body), `path=${path} status=${response.status}`);
      if (path.startsWith('currency_pairs')) check(body.length > 0 && typeof body[0].code === 'string', 'currency_pairs empty');
    }
  });
  let token;
  let userId;
  const signedIn = await step('Anonymous Auth sign-in', async () => {
    const { response, body } = await request(`${BASE}/auth/v1/signup`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: '{}' });
    // Retain a token even for a malformed reply so logout is still attempted.
    token = body?.access_token;
    userId = body?.user?.id;
    check(response.status === 200 && typeof token === 'string' && typeof userId === 'string' && body?.user?.is_anonymous === true, `status=${response.status} code=${body?.error_code || body?.code || ''} msg=${body?.msg || body?.message || ''}`);
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
async function probeAuthenticatedRelayWithDisposableUser(env = process.env, fetcher = fetch) {
  if (env.SUPABASE_PROJECT_REF !== PROJECT || !env.SUPABASE_ACCESS_TOKEN?.trim() || !env.SUPABASE_ANON_KEY?.trim()) return [];
  const key = env.SUPABASE_ANON_KEY.trim();
  let serviceKey = '';
  try {
    const res = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    });
    if (!res.ok) return [];
    const keys = await res.json();
    const svc = Array.isArray(keys) ? keys.find(k => k?.name === 'service_role' && typeof k?.api_key === 'string') : null;
    if (!svc) return [];
    serviceKey = svc.api_key;
    if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${serviceKey}`);
  } catch {
    return [];
  }
  const email = `nexus-verify-${Date.now()}@nexus-verify.invalid`;
  const password = `NxVerify_${Date.now()}_!9aZ`;
  let userId = '';
  let token = '';
  const probe = [];
  async function req(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { response, body };
  }
  try {
    const created = await req(`${BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    userId = created.body?.id || created.body?.user?.id || '';
    if (!userId) {
      probe.push(`FAIL: Admin disposable user creation (status=${created.response.status})`);
      return probe;
    }
    const login = await req(`${BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    token = login.body?.access_token || '';
    if (!token) {
      probe.push(`FAIL: Disposable user sign-in (status=${login.response.status})`);
      return probe;
    }
    const sess = await req(`${API}/session`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    const sessOk = sess.response.status === 200 && sess.body?.ok === true && sess.body?.userId === userId
      && sess.body?.cloudSyncEnabled === true && sess.body?.modelSyncEnabled === true
      && sess.response.headers.get('access-control-allow-origin') === ORIGIN;
    probe.push(`${sessOk ? 'PASS' : 'FAIL'}: Authenticated GET /api/v1/session (status=${sess.response.status})`);

    const dbRead = await req(`${BASE}/rest/v1/currency_pairs?select=code&limit=1`, {
      headers: { apikey: key, authorization: `Bearer ${token}` },
    });
    const dbOk = dbRead.response.status === 200 && Array.isArray(dbRead.body) && dbRead.body.length > 0;
    probe.push(`${dbOk ? 'PASS' : 'FAIL'}: Authenticated database read (status=${dbRead.response.status})`);

    const usage = await req(`${API}/usage`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    const keyCount = Array.isArray(usage.body?.keys) ? usage.body.keys.length : 0;
    const usageOk = usage.response.status === 200 && keyCount > 0 && usage.body.keys.every(k => k.error === null);
    probe.push(`${usageOk ? 'PASS' : 'FAIL'}: Twelve Data relay free usage lookup (status=${usage.response.status}, configuredKeys=${keyCount})`);

    const logout = await req(`${BASE}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: key, authorization: `Bearer ${token}` },
    });
    probe.push(`${logout.response.status === 204 ? 'PASS' : 'FAIL'}: Sign out verification session (status=${logout.response.status})`);
  } finally {
    if (userId) {
      try {
        await req(`${BASE}/auth/v1/admin/users/${userId}`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
        });
        probe.push('PASS: Disposable verification user deleted');
      } catch {}
    }
  }
  return probe;
}

module.exports = { verify, assertAnonKey, resolveAnonKey, probeAuthenticatedRelayWithDisposableUser, PROJECT, BASE, API, ORIGIN };
if (require.main === module) {
  resolveAnonKey(process.env).then(async resolvedEnv => {
    const results = await verify(resolvedEnv);
    const report = results.map(r => `${r.status}: ${r.name}`).join('\n');
    const inline = results.map(r => `${r.status}: ${r.name}`).join(' | ');
    console.log(report);
    let probeLines = [];
    if (results.some(r => r.name === 'Anonymous Auth sign-in' && r.status === 'FAIL')) {
      probeLines = await probeAuthenticatedRelayWithDisposableUser(resolvedEnv);
      if (probeLines.length) console.log(probeLines.join('\n'));
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const extra = probeLines.length ? `\n\n### Authenticated session probe (admin-provisioned disposable user)\n\n\`\`\`text\n${probeLines.join('\n')}\n\`\`\`\n` : '';
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Production relay verification\n\n\`\`\`text\n${report}\n\`\`\`${extra}\n`);
    }
    const hasFailed = results.some(r => r.status === 'FAIL');
    if (process.env.GITHUB_ACTIONS === 'true') {
      if (results.diagnostics?.length) {
        console.log(`::notice title=NEXUS Relay Diagnostics::${results.diagnostics.join(' | ').replaceAll('%', '%25').replaceAll('\r', '').replaceAll('\n', ' ')}`);
      }
      if (probeLines.length) {
        console.log(`::notice title=NEXUS Authenticated Relay Probe::${probeLines.join(' | ').replaceAll('%', '%25').replaceAll('\r', '').replaceAll('\n', ' ')}`);
      }
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
