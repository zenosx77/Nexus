// ── NEXUS worker configuration ──────────────────────────────────────────
// Precedence: env vars → defaults. Optional config.json next to package.json
// can carry pair lists etc. Nothing secret is ever defaulted.
import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) { return process.env[name] == null ? def : /^(1|true|yes)$/i.test(process.env[name]); }
function list(name) {
  const v = process.env[name];
  if (!v) return null;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(path.join(here, '..', 'config.json'), 'utf8'));
} catch { /* optional */ }

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  twelveDataKeys: list('TWELVEDATA_KEYS') || fileConfig.twelveDataKeys || [],
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramOpsChat: process.env.TELEGRAM_OPS_CHAT || '',

  pollSeconds: Math.max(10, num('WORKER_POLL_SECONDS', 30)),
  pairs: list('INGEST_PAIRS') || fileConfig.pairs || null,   // null = all active pairs from DB
  ingestOutputsize: Math.min(5000, Math.max(60, num('INGEST_OUTPUTSIZE', 360))),

  evaluationHorizon: Math.max(1, num('EVALUATION_HORIZON_CANDLES', 1)),
  evaluationGraceSeconds: num('EVALUATION_GRACE_SECONDS', 120),
  evaluationMaxDelayMinutes: num('EVALUATION_MAX_DELAY_MINUTES', 30),

  telegramRetryMax: num('TELEGRAM_RETRY_MAX', 3),

  alerts: {
    winrateFloorW20: num('ALERT_WINRATE_FLOOR_W20', 0.40),
    losingStreak: num('ALERT_LOSING_STREAK', 5),
    dataLagSeconds: num('ALERT_DATA_LAG_SECONDS', 180),
    pendingEvalMinutes: num('ALERT_PENDING_EVAL_MINUTES', 15),
    failedDeliveries: num('ALERT_FAILED_DELIVERIES', 5),
  },

  retentionDays: num('RETENTION_DAYS', 180),
  archiveBeforePrune: bool('ARCHIVE_BEFORE_PRUNE', false),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  workerId: `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
};

export function requireSupabase() {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')} — copy server/.env.example to server/.env and fill it in`);
  }
  return true;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function log(level, msg, extra) {
  if ((LEVELS[level] || 20) < (LEVELS[config.logLevel] || 20)) return;
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (extra !== undefined) console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
  else console.log(line);
}
