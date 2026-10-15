'use strict';
// No DB link/push/reset, gateway override, service key handling or worker jobs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertAnonKey } = require('./verify-relay.cjs');
const PROJECT = 'rxswndsebvaqztshbmlc';
const ORIGIN = 'https://zenosx77.github.io';
const OPTIONAL = ['TWELVEDATA_KEYS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_MAIN_CHAT',
  'TELEGRAM_PUBLIC_CHAT', 'TELEGRAM_VIP_CHAT', 'TELEGRAM_LIST_CHAT',
  'TELEGRAM_ADMIN_CHAT', 'NEXUS_TELEGRAM_ADMIN_USER_IDS'];
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
function deploy(env = process.env) {
  const values = configuration(env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-relay-'));
  const file = path.join(dir, '.env');
  function cli(args, label) {
    const result = spawnSync('supabase', args, { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
    // Do not echo CLI output: remote errors may contain secret values.
    if (result.error || result.status !== 0) throw new Error(`${label} failed; inspect Supabase dashboard (CLI output withheld)`);
    console.log(`${label}: passed`);
  }
  try {
    fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    cli(['secrets', 'set', '--project-ref', PROJECT, '--env-file', file], 'Supabase secret synchronization');
    // verify_jwt=false in tracked config is required for preflight and modern
    // signing keys. Application auth.getUser remains mandatory for all sessions.
    cli(['functions', 'deploy', 'nexus-relay', '--project-ref', PROJECT, '--use-api'], 'Edge function deployment');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { configuration, deploy };
if (require.main === module) {
  try { deploy(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
