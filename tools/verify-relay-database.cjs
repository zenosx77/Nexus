'use strict';
// Management API runs only the repository's reviewed read-only SQL verifiers.
// No DB password/service-role key, schema mutations or budget reservations.
const fs = require('node:fs');
const PROJECT = 'rxswndsebvaqztshbmlc';
const FILES = ['supabase/verify/0008_read_only.sql', 'supabase/verify/0009_read_only.sql'];
async function verifyDatabase(env = process.env, fetcher = fetch) {
  if (env.SUPABASE_PROJECT_REF !== PROJECT || !env.SUPABASE_ACCESS_TOKEN?.trim()) throw new Error('Missing Supabase management access or target mismatch');
  for (const file of FILES) {
    const query = fs.readFileSync(file, 'utf8');
    const response = await fetcher(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, read_only: true }),
    });
    // SQL bodies/results/errors are never emitted to workflow logs.
    if (!response.ok) throw new Error(`Read-only database verifier failed: ${file}. Review schema/privileges in the dashboard; no migration was applied.`);
    console.log(`PASS: ${file}`);
  }
}
module.exports = { verifyDatabase, FILES };
if (require.main === module) verifyDatabase().catch(() => {
  console.error('Read-only database verification failed. Check management access and existing 0008/0009 schema/privileges; no migration was applied.');
  process.exitCode = 1;
});
