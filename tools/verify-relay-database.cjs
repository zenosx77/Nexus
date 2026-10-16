'use strict';
// Management API database verifier and safe migration-0009 reconciler.
// Never logs SQL bodies, query rows, credentials, or raw error payloads.
const fs = require('node:fs');
const PROJECT = 'rxswndsebvaqztshbmlc';
const BASE = `https://${PROJECT}.supabase.co`;
const FILES = ['supabase/verify/0008_read_only.sql', 'supabase/verify/0009_read_only.sql'];
const MIGRATION_0009 = 'supabase/migrations/0009_shared_account_quota.sql';
const DIAGNOSTICS = [
  [/0008 missing/i, 'migration 0008_cloud_security_and_browser_budget.sql is not applied'],
  [/Unsafe direct quota mutation after 0009|quota table permits direct mutation/i,
    'quota table permits direct mutation; 0009 privilege revocations missing'],
  [/shared quota contract not ready/i, 'shared quota contract not ready in twelvedata_account_budget'],
  [/quota RLS is disabled|RLS disabled/i, 'required Row Level Security (RLS) is disabled'],
  [/missing service-role/i, 'missing required service_role privilege'],
  [/quota table readable by public client|quota RPC callable by public client|Unsafe .* privilege|Unsafe RPC EXECUTE/i,
    'unsafe anon/authenticated privilege detected'],
  [/0009 missing|twelvedata_quota_status|twelvedata_account_budget|reserve_twelvedata_account_credit/i,
    'migration 0009_shared_account_quota.sql is not applied'],
];
const REMEDIABLE_0009_REASONS = new Set([
  'migration 0009_shared_account_quota.sql is not applied',
  'quota table permits direct mutation; 0009 privilege revocations missing',
  'shared quota contract not ready in twelvedata_account_budget',
  'missing required service_role privilege',
]);
const INSPECTION_SQL = `select jsonb_build_object(
  'migration_ledger_present', to_regclass('supabase_migrations.schema_migrations') is not null,
  'table_present', to_regclass('public.twelvedata_account_budget') is not null,
  'singleton_present', case when to_regclass('public.twelvedata_account_budget') is not null
    then exists(select 1 from public.twelvedata_account_budget where account = 'twelvedata') else false end,
  'account_rpc_present', to_regprocedure('public.reserve_twelvedata_account_credit(text,integer,integer,text,integer)') is not null,
  'status_rpc_present', to_regprocedure('public.twelvedata_quota_status()') is not null,
  'svc_mutate_account', case when to_regclass('public.twelvedata_account_budget') is not null
    then has_table_privilege('service_role','public.twelvedata_account_budget','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') else null end,
  'svc_mutate_worker', case when to_regclass('public.twelvedata_credit_budget') is not null
    then has_table_privilege('service_role','public.twelvedata_credit_budget','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') else null end,
  'svc_mutate_browser', case when to_regclass('public.twelvedata_browser_credit_budget') is not null
    then has_table_privilege('service_role','public.twelvedata_browser_credit_budget','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') else null end,
  'storage_buckets_present', to_regclass('storage.buckets') is not null,
  'models_bucket_present', case when to_regclass('storage.buckets') is not null
    then exists(select 1 from storage.buckets where id = 'models') else false end,
  'models_bucket_private', case when to_regclass('storage.buckets') is not null
    then coalesce((select b.public = false from storage.buckets b where id = 'models'), false) else false end
) as state;`;
const ENSURE_MODELS_BUCKET_SQL = `do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('models', 'models', false)
    on conflict (id) do nothing;
  end if;
end $$;`;

function classifyFailure(status, bodyText) {
  if (status === 401 || status === 403) {
    return 'Supabase Management API rejected SUPABASE_ACCESS_TOKEN (HTTP 401/403)';
  }
  const text = String(bodyText || '');
  for (const [pattern, message] of DIAGNOSTICS) {
    if (pattern.test(text)) return message;
  }
  return 'review schema/privileges in the dashboard';
}

function sanitizeDiagnostic(status, raw) {
  const safe = String(raw || '')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_SB_SECRET]')
    .replace(/\bsbp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SBP]')
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED_TG_TOKEN]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED_HEX32]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
  return `HTTP ${status}: ${safe || 'empty response'}`;
}

function assertManagementEnv(env) {
  if (env.SUPABASE_PROJECT_REF !== PROJECT || !env.SUPABASE_ACCESS_TOKEN?.trim()) {
    throw new Error('Missing Supabase management access or target mismatch');
  }
}

async function runManagementSql(env, fetcher, query, readOnly = true) {
  const payload = readOnly ? { query, read_only: true } : { query, read_only: false };
  return fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function runVerifierFile(env, fetcher, file) {
  const query = fs.readFileSync(file, 'utf8');
  const response = await runManagementSql(env, fetcher, query, true);
  if (!response.ok) {
    const raw = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    const reason = classifyFailure(response.status, raw);
    const err = new Error(`FAIL: ${file} (${reason}). No migration was applied.`);
    err.file = file;
    err.reason = reason;
    err.status = response.status;
    err.diagnostic = sanitizeDiagnostic(response.status, raw);
    throw err;
  }
  console.log(`PASS: ${file}`);
}

async function verifyDatabase(env = process.env, fetcher = fetch) {
  assertManagementEnv(env);
  for (const file of FILES) {
    await runVerifierFile(env, fetcher, file);
  }
}

async function inspectDatabaseState(env = process.env, fetcher = fetch) {
  assertManagementEnv(env);
  const response = await runManagementSql(env, fetcher, INSPECTION_SQL, true);
  if (!response.ok) return null;
  try {
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows.find(r => r && typeof r.state === 'object') : null;
    const s = row?.state;
    if (!s || typeof s !== 'object') return null;
    const initial0009State = (s.table_present && s.singleton_present && s.account_rpc_present && s.status_rpc_present)
      ? 'present'
      : (!s.table_present && !s.account_rpc_present && !s.status_rpc_present ? 'absent' : 'partially-applied');
    return {
      migrationLedgerPresent: Boolean(s.migration_ledger_present),
      tablePresent: Boolean(s.table_present),
      singletonPresent: Boolean(s.singleton_present),
      accountRpcPresent: Boolean(s.account_rpc_present),
      statusRpcPresent: Boolean(s.status_rpc_present),
      quotaStatus: s.quota_status || null,
      svcMutateAccount: s.svc_mutate_account ?? null,
      svcMutateWorker: s.svc_mutate_worker ?? null,
      svcMutateBrowser: s.svc_mutate_browser ?? null,
      storageBucketsPresent: Boolean(s.storage_buckets_present),
      modelsBucketPresent: Boolean(s.models_bucket_present),
      modelsBucketPrivate: Boolean(s.models_bucket_private),
      initial0009State,
    };
  } catch {
    return null;
  }
}

async function ensurePrivateModelsBucketViaStorageApi(env, fetcher) {
  try {
    const keysRes = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    });
    if (!keysRes.ok) return false;
    const keys = await keysRes.json();
    const svc = Array.isArray(keys) ? keys.find(k => k?.name === 'service_role' && typeof k?.api_key === 'string') : null;
    if (!svc) return false;
    if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${svc.api_key}`);
    const createRes = await fetcher(`${BASE}/storage/v1/bucket`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: {
        apikey: svc.api_key,
        authorization: `Bearer ${svc.api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'models', name: 'models', public: false }),
    });
    return createRes.ok || createRes.status === 409;
  } catch {
    return false;
  }
}

async function reconcileAndVerifyDatabase(env = process.env, fetcher = fetch) {
  assertManagementEnv(env);
  await runVerifierFile(env, fetcher, FILES[0]);
  const state = await inspectDatabaseState(env, fetcher);
  if (env.GITHUB_ACTIONS === 'true' && state) {
    console.log(`::notice title=NEXUS DB Inspection::${escapeAnnotation(JSON.stringify(state))}`);
  }
  const initial0009State = state?.initial0009State || 'unknown';
  let applied0009 = false;
  try {
    await runVerifierFile(env, fetcher, FILES[1]);
  } catch (err) {
    if (env.GITHUB_ACTIONS === 'true') {
      console.log(`::notice title=NEXUS 0009 Initial Check::${escapeAnnotation(`${err?.reason || 'failed'} | ${err?.diagnostic || ''}`)}`);
    }
    if (!REMEDIABLE_0009_REASONS.has(err?.reason)) throw err;
    const rawMigrationSql = fs.readFileSync(MIGRATION_0009, 'utf8');
    const migrationSql = `set session characteristics as transaction read write;\nset default_transaction_read_only = off;\n` +
      rawMigrationSql.replace(/^\s*begin\s*;/im, 'begin read write;');
    const applyResponse = await runManagementSql(env, fetcher, migrationSql, false);
    if (!applyResponse.ok) {
      const raw = typeof applyResponse.text === 'function' ? await applyResponse.text().catch(() => '') : '';
      const reason = classifyFailure(applyResponse.status, raw);
      const detail = sanitizeDiagnostic(applyResponse.status, raw);
      throw new Error(`FAIL: ${MIGRATION_0009} (${reason} | ${detail}).`);
    }
    applied0009 = true;
    console.log(`APPLIED: ${MIGRATION_0009} (initial state: ${initial0009State})`);
    await verifyDatabase(env, fetcher);
  }
  let modelsBucketPrivate = Boolean(state?.modelsBucketPrivate);
  if (state?.storageBucketsPresent && !state?.modelsBucketPresent) {
    const bucketRes = await runManagementSql(env, fetcher, ENSURE_MODELS_BUCKET_SQL, false);
    if (!bucketRes.ok) {
      await ensurePrivateModelsBucketViaStorageApi(env, fetcher);
    }
    const afterBucket = await inspectDatabaseState(env, fetcher);
    modelsBucketPrivate = Boolean(afterBucket?.modelsBucketPrivate);
    if (modelsBucketPrivate) {
      console.log(`PASS: private models bucket ensured (private=${modelsBucketPrivate})`);
    }
  }
  return {
    status: 'PASS',
    initial0009State,
    applied0009,
    modelsBucketPrivate,
  };
}

function escapeAnnotation(text) {
  return String(text || '').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

module.exports = { verifyDatabase, reconcileAndVerifyDatabase, inspectDatabaseState, classifyFailure, FILES, MIGRATION_0009 };

if (require.main === module) {
  reconcileAndVerifyDatabase().then(report => {
    const summary = `PASS: ${FILES[0]} | 0009_initial=${report.initial0009State} | 0009_applied=${report.applied0009} | PASS: ${FILES[1]} | models_bucket_private=${report.modelsBucketPrivate}`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Database security and shared quota verification\n\n\`\`\`text\n${summary}\n\`\`\`\n`);
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::notice title=NEXUS Database Verification::${escapeAnnotation(summary)}`);
    }
  }).catch(error => {
    const message = error?.message || 'Read-only database verification failed; no migration was applied.';
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Database security and shared quota verification\n\n\`\`\`text\n${message}\n\`\`\`\n`);
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::error title=NEXUS Database Verification::${escapeAnnotation(message)}`);
    }
    process.exitCode = 1;
  });
}
