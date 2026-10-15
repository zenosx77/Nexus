// ── NEXUS worker + authenticated relay configuration ────────────────────
// Secret values come only from the host environment (or server/.env locally).
// The static browser app receives no generated provider or Telegram credentials.
import './env.js';
function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) { return process.env[name] == null ? def : /^(1|true|yes)$/i.test(process.env[name]); }
function list(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}
function positiveInt(name, def, max = 1_000_000) {
  return Math.min(max, Math.max(0, Math.floor(num(name, def))));
}

const twelveDataKeys = list('TWELVEDATA_KEYS');
const mainTelegramChat = process.env.TELEGRAM_MAIN_CHAT || '';
const telegramChats = {
  main: mainTelegramChat,
  public: process.env.TELEGRAM_PUBLIC_CHAT || mainTelegramChat,
  vip: process.env.TELEGRAM_VIP_CHAT || mainTelegramChat,
  list: process.env.TELEGRAM_LIST_CHAT || mainTelegramChat,
  admin: process.env.TELEGRAM_ADMIN_CHAT || mainTelegramChat,
};
const telegramAdminUserIds = list('NEXUS_TELEGRAM_ADMIN_USER_IDS');
const secretValues = [
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  process.env.TELEGRAM_BOT_TOKEN || '',
  process.env.TELEGRAM_MAIN_CHAT || '',
  process.env.TELEGRAM_PUBLIC_CHAT || '',
  process.env.TELEGRAM_VIP_CHAT || '',
  process.env.TELEGRAM_LIST_CHAT || '',
  process.env.TELEGRAM_ADMIN_CHAT || '',
  process.env.TELEGRAM_OPS_CHAT || '',
  ...twelveDataKeys,
].filter(Boolean);

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  twelveDataKeys,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramOpsChat: process.env.TELEGRAM_OPS_CHAT || '',
  telegramChats,
  telegramAdminUserIds,

  apiPort: positiveInt('NEXUS_API_PORT', 8787, 65535),
  allowedOrigins: list('NEXUS_ALLOWED_ORIGINS'),
  apiUserRateLimitPerMinute: positiveInt('NEXUS_API_USER_RATE_LIMIT_PER_MINUTE', 60, 100_000),
  telegramRateLimitPerMinute: positiveInt('NEXUS_TELEGRAM_RATE_LIMIT_PER_MINUTE', 30, 10_000),
  cloudSyncEnabled: bool('NEXUS_CLOUD_SYNC_ENABLED', true),
  cloudModelEnabled: bool('NEXUS_CLOUD_MODEL_ENABLED', true),

  pollSeconds: Math.max(10, num('WORKER_POLL_SECONDS', 30)),
  pairs: list('INGEST_PAIRS').length ? list('INGEST_PAIRS') : null, // null = all active pairs from DB
  ingestOutputsize: Math.min(5000, Math.max(60, num('INGEST_OUTPUTSIZE', 360))),
  ingestMinIntervalSeconds: Math.max(0, Math.floor(num('INGEST_MIN_INTERVAL_SECONDS', 60))),
  twelveDataDailyCreditLimit: positiveInt('TWELVEDATA_DAILY_CREDIT_LIMIT', 700, 700),
  twelveDataMinuteCreditLimit: positiveInt('TWELVEDATA_PER_MINUTE_LIMIT', 6, 6),
  twelveDataBrowserDailyCreditLimit: positiveInt('TWELVEDATA_BROWSER_DAILY_CREDIT_LIMIT', 700, 700),
  twelveDataBrowserMinuteCreditLimit: positiveInt('TWELVEDATA_BROWSER_PER_MINUTE_LIMIT', 6, 6),

  evaluationHorizon: Math.max(1, num('EVALUATION_HORIZON_CANDLES', 1)),
  evaluationGraceSeconds: num('EVALUATION_GRACE_SECONDS', 120),
  evaluationMaxDelayMinutes: Math.max(90, num('EVALUATION_MAX_DELAY_MINUTES', 90)),

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
  let url;
  try { url = new URL(config.supabaseUrl); } catch { /* checked below */ }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('SUPABASE_URL must be a valid HTTP(S) project URL');
  }
  return true;
}

export function telegramChannelConfigured(channel) {
  return !!(config.telegramBotToken && config.telegramChats[channel]);
}

export function redactSecrets(value, maxLength = 1000) {
  let text = String(value == null ? '' : value);
  for (const secret of secretValues) {
    if (secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  const limit = Number.isFinite(Number(maxLength)) ? Math.max(0, Math.floor(Number(maxLength))) : 1000;
  return text
    .replace(/(SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*)[^\s,]+/gi, '$1[redacted]')
    .replace(/(TELEGRAM_BOT_TOKEN\s*[=:]\s*)[^\s,]+/gi, '$1[redacted]')
    .replace(/\bsb_secret_[A-Za-z0-9_-]+/gi, '[redacted Supabase secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[redacted JWT]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted Telegram token]')
    .replace(/\b[0-9a-f]{32}\b/gi, '[redacted provider key]')
    .replace(/(apikey=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, limit);
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function log(level, msg, extra) {
  if ((LEVELS[level] || 20) < (LEVELS[config.logLevel] || 20)) return;
  const line = `${new Date().toISOString()} [${level}] ${redactSecrets(msg)}`;
  if (extra !== undefined) {
    let serialized;
    try { serialized = typeof extra === 'string' ? extra : JSON.stringify(extra); }
    catch { serialized = '[unserializable log detail]'; }
    console.log(line, redactSecrets(serialized));
  } else console.log(line);
}
