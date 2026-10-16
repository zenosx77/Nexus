'use strict';
// No DB link/push/reset, gateway override, service key handling or worker jobs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertAnonKey, resolveAnonKey } = require('./verify-relay.cjs');
const PROJECT = 'rxswndsebvaqztshbmlc';
const ORIGIN = 'https://zenosx77.github.io';
const OPTIONAL = ['TWELVEDATA_KEYS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_MAIN_CHAT',
  'TELEGRAM_PUBLIC_CHAT', 'TELEGRAM_VIP_CHAT', 'TELEGRAM_LIST_CHAT',
  'TELEGRAM_ADMIN_CHAT', 'NEXUS_TELEGRAM_ADMIN_USER_IDS'];

function sanitizeCliText(raw, secretValues = []) {
  let s = String(raw || '');
  for (const val of secretValues) {
    if (val && val.length >= 4) s = s.split(val).join('[REDACTED]');
  }
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_SB_SECRET]')
    .replace(/\bsbp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SBP]')
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED_TG_TOKEN]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED_HEX32]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 260);
}

function classifyCliFailure(result, secretValues = []) {
  const combined = `${result?.error?.message || ''}\n${result?.stderr || ''}\n${result?.stdout || ''}`;
  const detail = sanitizeCliText(combined, secretValues);
  if (/401|403|unauthorized|forbidden|access token|privileges|scope/i.test(combined)) {
    return `management token rejected or insufficient scope (${detail || 'HTTP 401/403'})`;
  }
  if (/not found|404/i.test(combined)) return `target project or function endpoint not found (${detail || 'HTTP 404'})`;
  if (/bundle|import|entrypoint|deno|module|syntax|typecheck/i.test(combined)) {
    return `function bundling or import resolution error (${detail})`;
  }
  if (/timeout|timed out|network|econn|enotfound/i.test(combined)) {
    return `Supabase API network or timeout error (${detail})`;
  }
  return `exit status ${result?.status ?? 'error'}: ${detail || 'no diagnostic output'}`;
}

function configuration(env) {
  if (env.SUPABASE_PROJECT_REF !== PROJECT || env.NEXUS_ALLOWED_ORIGINS !== ORIGIN) {
    throw new Error('Production target/origin mismatch');
  }
  for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_ANON_KEY']) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
  }
  assertAnonKey(env.SUPABASE_ANON_KEY);
  if (env.NEXUS_VERIFY_TELEGRAM === 'true') {
    for (const name of ['TELEGRAM_ADMIN_CHAT', 'NEXUS_VERIFY_ADMIN_ACCESS_TOKEN']) {
      if (!env[name]?.trim()) throw new Error(`Private Telegram test requires ${name}`);
    }
  }
  const values = { NEXUS_ALLOWED_ORIGINS: ORIGIN };
  for (const name of OPTIONAL) if (env[name]?.trim()) values[name] = env[name].trim();
  // Deliberately reject dotenv syntax, whitespace and line injection. Empty
  // optional secrets preserve hosted values; they never erase configuration.
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9_:@,./+\-]+$/.test(value)) throw new Error(`Invalid secret format: ${name}`);
  }
  return values;
}

async function inspectManagementCapabilities(env, fetcher = fetch) {
  const info = { secretNames: null, secretsStatus: null, functionsStatus: null, functionSlugs: null };
  try {
    const sRes = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/secrets`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    });
    info.secretsStatus = sRes.status;
    if (sRes.ok) {
      const list = await sRes.json();
      if (Array.isArray(list)) info.secretNames = list.map(x => x?.name).filter(Boolean);
    }
  } catch {}
  try {
    const fRes = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/functions`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    });
    info.functionsStatus = fRes.status;
    if (fRes.ok) {
      const list = await fRes.json();
      if (Array.isArray(list)) info.functionSlugs = list.map(x => `${x?.slug}:${x?.status || 'unknown'}`);
    }
  } catch {}
  return info;
}

function deploy(env = process.env) {
  const values = configuration(env);
  const secretValues = [env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_ANON_KEY, ...Object.values(values)].filter(Boolean);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-relay-'));
  const file = path.join(dir, '.env');
  function cli(args, label) {
    const result = spawnSync('supabase', args, { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
    // Do not echo CLI output: remote errors may contain secret values.
    if (result.error || result.status !== 0) {
      throw new Error(`${label} failed (${classifyCliFailure(result, secretValues)}); inspect Supabase dashboard (CLI output withheld)`);
    }
    console.log(`${label}: passed`);
  }
  const errors = [];
  try {
    fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    try {
      cli(['secrets', 'set', '--project-ref', PROJECT, '--env-file', file], 'Supabase secret synchronization');
    } catch (e) {
      errors.push(e.message);
    }
    try {
      // verify_jwt=false in tracked config is required for preflight and modern
      // signing keys. Application auth.getUser remains mandatory for all sessions.
      cli(['functions', 'deploy', 'nexus-relay', '--project-ref', PROJECT, '--use-api'], 'Edge function deployment');
    } catch (e) {
      errors.push(e.message);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (errors.length) throw new Error(errors.join(' || '));
}

module.exports = { configuration, deploy, classifyCliFailure };

if (require.main === module) {
  resolveAnonKey(process.env).then(async resolvedEnv => {
    const provided = ['NEXUS_ALLOWED_ORIGINS', ...OPTIONAL.filter(k => Boolean(resolvedEnv[k]?.trim()))];
    const caps = await inspectManagementCapabilities(resolvedEnv);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::notice title=NEXUS Secret & Function Inspection::provided=[${provided.join(',')}] | hostedSecretsStatus=${caps.secretsStatus} hostedSecrets=[${(caps.secretNames || []).join(',')}] | hostedFunctionsStatus=${caps.functionsStatus} hostedFunctions=[${(caps.functionSlugs || []).join(',')}]`);
    }
    deploy(resolvedEnv);
    const summary = `Supabase secret synchronization: passed (${provided.join(', ')}) | Edge function deployment: passed`;
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Production relay deployment\n\n\`\`\`text\n${summary}\n\`\`\`\n`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=NEXUS Relay Deployment::${summary}`);
  }).catch(error => {
    const msg = error?.message || 'Relay deployment failed';
    console.error(msg);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Production relay deployment\n\n\`\`\`text\n${msg}\n\`\`\`\n`);
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=NEXUS Relay Deployment::${msg}`);
    process.exitCode = 1;
  });
}
