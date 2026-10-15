// ── NEXUS worker entrypoint ─────────────────────────────────────────────
// CLI:  node src/index.js <command>
//   loop          run forever (default) — ingest/evaluate/telegram/alerts each
//                 cycle, risk every 5 min, backfill every 6h, housekeeping daily
//   once          run one full pass of everything and exit (cron-friendly)
//   ingest        one ingestion pass
//   backfill      find + fill gaps from the last 24h
//   evaluate      one outcome-evaluation pass
//   risk          one risk-snapshot pass
//   telegram      one delivery-retry pass
//   alerts        one alert-check pass
//   housekeeping  prune logs/snapshots/candles (+ archive first when enabled)
//   settings-sync write effective non-secret settings to system_settings
//   api           run the authenticated browser relay (separate process)
import './env.js';
import { config, log } from './config.js';
import { db } from './db.js';
import { runIngest, backfillLocked } from './ingest.js';
import { evaluateLocked } from './evaluate.js';
import { riskLocked } from './risk.js';
import { telegramLocked } from './telegram.js';
import { runAlertChecks } from './alerts.js';
import { housekeepingLocked } from './housekeeping.js';
import { createNexusApiServer } from './api.js';

/** Run a job, never let one failure kill the loop. */
async function safe(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    log('debug', `${name} ok in ${Date.now() - t0}ms`);
  } catch (err) {
    log('error', `${name} failed after ${Date.now() - t0}ms`, err && err.message);
  }
}

async function cycle() {
  await safe('ingest', () => runIngest('live'));
  await safe('evaluate', evaluateLocked);
  await safe('telegram', telegramLocked);
  await safe('alerts', () => runAlertChecks());
}

async function once() {
  await safe('settings-sync', settingsSync);
  await cycle();
  await safe('risk', riskLocked);
  await safe('backfill', () => backfillLocked());
  await safe('housekeeping', housekeepingLocked);
}

async function loop() {
  log('info', `nexus worker ${config.workerId} starting — poll ${config.pollSeconds}s, ${config.twelveDataKeys.length} API key(s)`);
  await once();
  // `once()` already ran each maintenance task; schedule the next run relative
  // to now instead of repeating backfill/housekeeping on the very first poll.
  let riskAt = Date.now(), backfillAt = riskAt, housekeepAt = riskAt;
  const minute = 60_000;
  // istanbul ignore next
  setInterval(async () => {
    const now = Date.now();
    await cycle();
    if (now - riskAt > 5 * minute) { riskAt = now; await safe('risk', riskLocked); }
    if (now - backfillAt > 6 * 60 * minute) { backfillAt = now; await safe('backfill', () => backfillLocked()); }
    if (now - housekeepAt > 24 * 60 * minute) { housekeepAt = now; await safe('housekeeping', housekeepingLocked); }
  }, config.pollSeconds * 1000).unref();
  // keep the process alive (setInterval is unref'd for clean testability)
  setInterval(() => {}, 1 << 30);
}

/** Run the HTTP relay separately from the scheduled worker. */
function apiServer() {
  const server = createNexusApiServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.apiPort, '0.0.0.0', () => {
      log('info', `nexus API relay listening on 0.0.0.0:${config.apiPort}`);
    });
    server.once('close', resolve);
  });
}

/** Write effective NON-SECRET settings to system_settings (dashboard-visible). */
async function settingsSync() {
  const DBC = await db();
  const rows = [
    ['evaluation.horizon_candles', config.evaluationHorizon],
    ['evaluation.grace_seconds', config.evaluationGraceSeconds],
    ['evaluation.max_delay_minutes', config.evaluationMaxDelayMinutes],
    ['telegram.retry_max', config.telegramRetryMax],
    ['alerts.winrate_floor_w20', config.alerts.winrateFloorW20],
    ['alerts.losing_streak', config.alerts.losingStreak],
    ['alerts.data_lag_seconds', config.alerts.dataLagSeconds],
    ['alerts.pending_eval_minutes', config.alerts.pendingEvalMinutes],
    ['alerts.failed_deliveries', config.alerts.failedDeliveries],
    ['retention.candles_days', config.retentionDays],
    ['worker.poll_seconds', config.pollSeconds],
    ['worker.ingest_min_interval_seconds', config.ingestMinIntervalSeconds],
    ['worker.twelvedata_daily_credit_limit', config.twelveDataDailyCreditLimit],
    ['worker.twelvedata_per_minute_limit', config.twelveDataMinuteCreditLimit],
    ['worker.archive_before_prune', config.archiveBeforePrune],
  ].map(([key, value]) => ({ key, value, updated_by: 'worker' }));
  const { error } = await DBC.from('system_settings').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(`settings-sync: ${error.message}`);
  log('info', `settings-sync: ${rows.length} non-secret settings written`);
}

const command = process.argv[2] || 'loop';
const commands = {
  loop, once,
  ingest: () => runIngest('live'),
  backfill: () => backfillLocked(),
  evaluate: () => evaluateLocked(),
  risk: () => riskLocked(),
  telegram: () => telegramLocked(),
  alerts: () => runAlertChecks(),
  housekeeping: () => housekeepingLocked(),
  'settings-sync': settingsSync,
  api: apiServer,
};

if (!commands[command]) {
  console.error(`unknown command: ${command}\nusage: node src/index.js [${Object.keys(commands).join('|')}]`);
  process.exit(2);
}

try {
  await commands[command]();
  if (command !== 'loop') {
    log('info', `${command} done`);
    process.exit(0);
  }
} catch (err) {
  log('error', `${command} fatal`, err && err.message);
  process.exit(1);
}
