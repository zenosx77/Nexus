// Scheduled CLI: deliberately excludes prediction generation, Telegram and maintenance.
import { appendFileSync } from 'node:fs';
import { db } from './db.js';
import { config, requireSupabase } from './config.js';
import { runIngest, backfillLocked } from './ingest.js';
import { evaluateLocked } from './evaluate.js';
import { sharedQuotaContract } from './credit-budget.js';
import { limitJobCredits } from './twelvedata.js';

export function verdict(locked, mode) {
  if (!locked.ran) return { verdict: 'deferred', reason: 'lock-held' };
  if (mode === 'job-outcomes') {
    const r = locked.result;
    return { verdict: r.evaluated + r.invalid ? 'verified' : 'deferred',
      reason: r.due ? 'settled-or-waiting-for-candles' : 'no-due-browser-predictions', ...r };
  }
  const rows = locked.result;
  if (rows.some(r => r.error && (!r.budgetLimited || !['daily-limit','minute-limit','job-limit'].includes(r.budgetReason)))) throw new Error('data job failed');
  if (rows.some(r => !r.error && !r.verified)) throw new Error('missing database readback');
  return { verdict: rows.some(r => r.verified) ? 'verified' : 'deferred',
    attempted: rows.length, verified: rows.filter(r => r.verified).length,
    stale: rows.filter(r => r.stale).length,
    budgetDeferred: rows.filter(r => r.budgetLimited).length,
    reason: rows.length ? 'readback-complete-see-stale-and-budget-counts' : 'cadence-no-pairs-or-no-gaps' };
}

export async function preflight(client) {
  requireSupabase();
  if (!config.twelveDataKeys.length) throw new Error('provider configuration missing');
  const c = client ?? await db();
  for (const [table, columns] of Object.entries({
    currency_pairs: 'code,is_active', market_candles: 'pair_code,timeframe,ts',
    predictions: 'id,source,is_shadow', trade_outcomes: 'prediction_id,outcome,is_valid',
    model_versions: 'id,artifact_sha256,artifact_payload', training_runs: 'id,status',
    ingestion_runs: 'id,status', market_features: 'pair_code,ts',
    job_locks: 'name', system_settings: 'key,value',
    twelvedata_credit_budget: 'scope,daily_calls,minute_calls',
    twelvedata_browser_credit_budget: 'scope,daily_calls,minute_calls',
    v_prediction_accuracy: 'id,outcome',
  })) {
    const { error } = await c.from(table).select(columns).limit(1);
    if (error) throw new Error('required schema read failed');
  }
  const { data: quota, error: quotaError } = await c.rpc('twelvedata_quota_status');
  if (quotaError || !sharedQuotaContract(quota) || quota.initialized !== true || quota.rolling_window_seconds !== 61) throw new Error('shared quota verification failed');
  const { data: bucket, error } = await c.storage.getBucket('models');
  if (error || !bucket || bucket.public !== false) throw new Error('private model bucket verification failed');
  return { verdict: 'verified', scope: 'schema-private-bucket-and-shared-quota-contract',
    productionReady: false, reason: 'hosted-policy-cutover-and-account-consumer-verification-required' };
}

export async function runJob(mode) {
  let result;
  try {
    if (mode === 'preflight') result = await preflight();
    else {
      limitJobCredits(6); // includes failed requests and key failover, not just successful pairs
      const fn = { 'job-ingest': runIngest, 'job-outcomes': evaluateLocked, 'job-backfill': backfillLocked }[mode];
      if (!fn) throw new Error('unknown job');
      result = verdict(await fn(), mode);
    }
    summary(mode, result);
    return result;
  } catch {
    summary(mode, { verdict: 'failed', reason: 'configuration-provider-or-database-postcondition-failed' });
    throw new Error('job failed; inspect redacted summary and read-only database checks');
  }
}
function summary(mode, result) {
  const text = JSON.stringify({ job: mode, ...result });
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### NEXUS job\n\n\`\`\`json\n${text}\n\`\`\`\n`);
}
