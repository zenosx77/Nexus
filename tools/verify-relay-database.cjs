'use strict';
// Management API runs only the repository's reviewed read-only SQL verifiers.
// No DB password/service-role key, schema mutations or budget reservations.
const fs = require('node:fs');
const PROJECT = 'rxswndsebvaqztshbmlc';
const FILES = ['supabase/verify/0008_read_only.sql', 'supabase/verify/0009_read_only.sql'];
const DIAGNOSTICS = [
  [/0008 missing/i, 'migration 0008_cloud_security_and_browser_budget.sql is not applied'],
  [/0009 missing|twelvedata_quota_status|twelvedata_account_budget|reserve_twelvedata_account_credit/i,
    'migration 0009_shared_account_quota.sql is not applied'],
  [/Unsafe direct quota mutation after 0009|quota table permits direct mutation/i,
    'quota table permits direct mutation; 0009 privilege revocations missing'],
  [/shared quota contract not ready/i, 'shared quota contract not ready in twelvedata_account_budget'],
  [/quota RLS is disabled|RLS disabled/i, 'required Row Level Security (RLS) is disabled'],
  [/missing service-role/i, 'missing required service_role privilege'],
  [/quota table readable by public client|quota RPC callable by public client|Unsafe .* privilege|Unsafe RPC EXECUTE/i,
    'unsafe anon/authenticated privilege detected'],
];
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
async function verifyDatabase(env = process.env, fetcher = fetch) {
  if (env.SUPABASE_PROJECT_REF !== PROJECT || !env.SUPABASE_ACCESS_TOKEN?.trim()) throw new Error('Missing Supabase management access or target mismatch');
  for (const file of FILES) {
    const query = fs.readFileSync(file, 'utf8');
    const response = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, read_only: true }),
    });
    // SQL bodies/results/raw errors are never emitted to workflow logs.
    if (!response.ok) {
      const raw = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      const reason = classifyFailure(response.status, raw);
      throw new Error(`FAIL: ${file} (${reason}). No migration was applied.`);
    }
    console.log(`PASS: ${file}`);
  }
}
module.exports = { verifyDatabase, classifyFailure, FILES };
if (require.main === module) verifyDatabase().catch(error => {
  console.error(error?.message || 'Read-only database verification failed; no migration was applied.');
  process.exitCode = 1;
});
