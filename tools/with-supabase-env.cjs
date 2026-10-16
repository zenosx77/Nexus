'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { PROJECT, BASE } = require('./verify-relay.cjs');

function isServiceRoleJwt(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.role === 'service_role' && payload?.ref === PROJECT;
  } catch {
    return false;
  }
}

async function resolveWorkerEnv(env = process.env, fetcher = fetch) {
  const resolved = { ...env };
  if (!resolved.SUPABASE_PROJECT_REF?.trim()) resolved.SUPABASE_PROJECT_REF = PROJECT;
  if (!resolved.SUPABASE_URL?.trim()) resolved.SUPABASE_URL = BASE;
  if (!resolved.SUPABASE_SERVICE_ROLE_KEY?.trim() && resolved.SUPABASE_ACCESS_TOKEN?.trim()) {
    try {
      const res = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${resolved.SUPABASE_ACCESS_TOKEN}` },
      });
      if (res.ok) {
        const keys = await res.json();
        if (Array.isArray(keys)) {
          const svc = keys.find(k => typeof k?.api_key === 'string' && (k.name === 'service_role' || isServiceRoleJwt(k.api_key)));
          if (svc) {
            if (resolved.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${svc.api_key}`);
            resolved.SUPABASE_SERVICE_ROLE_KEY = svc.api_key;
          }
        }
      }
    } catch {}
  }
  return resolved;
}

function redact(text) {
  return String(text || '')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_SB_SECRET]')
    .replace(/\bsbp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SBP]')
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED_TG_TOKEN]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED_HEX32]');
}

function escapeAnnotation(text) {
  return redact(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', ' | ');
}

module.exports = { resolveWorkerEnv, isServiceRoleJwt, redact };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node tools/with-supabase-env.cjs <command> [args...]');
    process.exit(2);
  }
  const label = args.join(' ');
  resolveWorkerEnv(process.env).then(resolvedEnv => {
    const result = spawnSync(args[0], args.slice(1), {
      env: resolvedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = redact(result.stdout || '').trim();
    const err = redact(result.stderr || '').trim();
    if (out) console.log(out);
    if (err) console.error(err);
    const tail = (err || out || `exit ${result.status ?? 1}`).split('\n').slice(-4).join(' | ');
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### \`${label}\`\n\n\`\`\`text\n${out || err || 'completed'}\n\`\`\`\n`);
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
      const ok = !result.error && result.status === 0;
      const level = ok ? 'notice' : 'error';
      console[ok ? 'log' : 'error'](`::${level} title=${escapeAnnotation(label)}::${escapeAnnotation(tail)}`);
    }
    if (result.error || result.status !== 0) {
      process.exitCode = result.status || 1;
    }
  }).catch(error => {
    const msg = redact(error?.message || 'Worker wrapper failed');
    console.error(msg);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::error title=${escapeAnnotation(label)}::${escapeAnnotation(msg)}`);
    }
    process.exitCode = 1;
  });
}
