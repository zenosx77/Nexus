// ── Supabase client (service role — server only) ────────────────────────
// supabase-js is imported lazily so pure-logic modules (validate, outcome,
// risk stats, features) can be unit-tested without any dependency installed.
import { config, requireSupabase } from './config.js';

let client = null;

export async function db() {
  if (client) return client;
  requireSupabase();
  const { createClient } = await import('@supabase/supabase-js');
  client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'nexus-worker' } },
  });
  return client;
}

/** Run `fn` while holding a database job lock (idempotent, crash-safe). */
export async function withJobLock(name, ttlSeconds, fn) {
  const c = await db();
  const { data, error } = await c.rpc('try_job_lock', {
    p_name: name, p_owner: config.workerId, p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`job lock ${name}: ${error.message}`);
  if (!data) return { ran: false, result: null };      // another worker holds it
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await c.rpc('release_job_lock', { p_name: name, p_owner: config.workerId });
  }
}

/** Upsert rows in bounded chunks (PostgREST-friendly). Returns rows written. */
export async function upsertChunked(table, rows, onConflict, chunkSize = 500) {
  const c = await db();
  let upserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await c.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
    upserted += chunk.length;
  }
  return upserted;
}
