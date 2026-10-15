// ── Twelve Data request budgets ─────────────────────────────────────────
// Each paid one-symbol data request reserves one credit in Supabase before
// the provider is contacted. Worker and browser-relay scopes are separate.
// api_usage is intentionally free and does not spend either credit budget.

import { config } from './config.js';
import { db } from './db.js';

export const LIVE_INGEST_BUDGET_SHARE = 0.8; // keep 20% for backfill/retries

export class TwelveDataBudgetError extends Error {
  constructor(reason, message, retryAfterMs = 0) {
    super(message);
    this.name = 'TwelveDataBudgetError';
    this.code = 'TWELVEDATA_BUDGET_BLOCKED';
    this.reason = reason;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
  }
}

const dailyBlockedUntil = { worker: 0, browser: 0 };

export function nextUtcMidnightMs(now = Date.now()) {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return next.getTime();
}

/** Number of pairs to rotate through per live-ingest pass. */
export function ingestBatchSize(pairCount, perMinuteLimit = config.twelveDataMinuteCreditLimit) {
  const pairs = Math.max(0, Math.floor(Number(pairCount) || 0));
  const minuteLimit = Math.max(0, Math.floor(Number(perMinuteLimit) || 0));
  return Math.min(pairs, minuteLimit);
}

/**
 * Minimum delay between live-ingest batches so they use at most 80% of the
 * worker's daily request budget. Each pass handles no more than the minute
 * cap; pairs rotate between passes so a large watchlist is not starved.
 */
export function recommendedIngestIntervalSeconds(
  pairCount,
  dailyLimit = config.twelveDataDailyCreditLimit,
  perMinuteLimit = config.twelveDataMinuteCreditLimit,
  configuredMinimum = config.ingestMinIntervalSeconds,
) {
  const batchSize = ingestBatchSize(pairCount, perMinuteLimit);
  const cap = Math.max(0, Math.floor(Number(dailyLimit) || 0));
  const minimum = Math.max(0, Math.floor(Number(configuredMinimum) || 0));
  if (!batchSize || !cap) return Infinity;
  const usableDailyBudget = Math.max(1, Math.floor(cap * LIVE_INGEST_BUDGET_SHARE));
  const rateLimitSpacing = Math.ceil((86_400 * batchSize) / usableDailyBudget);
  return Math.max(minimum, rateLimitSpacing);
}

async function reserveCredit({ scope, rpc, dailyLimit, minuteLimit, extra = {} }) {
  const now = Date.now();
  if (now < dailyBlockedUntil[scope]) {
    throw new TwelveDataBudgetError('daily-limit', `Twelve Data ${scope} daily credit limit reached; requests resume at 00:00 UTC.`, dailyBlockedUntil[scope] - now);
  }

  let client;
  try {
    client = await db();
  } catch (err) {
    throw new TwelveDataBudgetError('guard-unavailable', `Twelve Data credit guard unavailable; request blocked: ${err.message}`);
  }

  let data, error;
  try {
    ({ data, error } = await client.rpc(rpc, {
      p_daily_limit: dailyLimit,
      p_minute_limit: minuteLimit,
      ...extra,
    }));
  } catch (err) {
    throw new TwelveDataBudgetError('guard-unavailable', `Twelve Data credit guard unavailable; request blocked: ${err.message}`);
  }
  if (error) {
    throw new TwelveDataBudgetError('guard-unavailable', `Twelve Data credit guard unavailable; request blocked: ${error.message}`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.allowed !== true) {
    const reason = result && result.reason || 'guard-unavailable';
    const retryAfterMs = Math.max(0, Number(result && result.retry_after_ms) || 0);
    if (reason === 'daily-limit') dailyBlockedUntil[scope] = nextUtcMidnightMs(now);
    const message = reason === 'daily-limit'
      ? `Twelve Data ${scope} daily credit limit reached (${dailyLimit}/UTC day); requests resume at 00:00 UTC.`
      : reason === 'settlement-reserve'
        ? 'Twelve Data routine browser budget reached its 80% cap; remaining credits are reserved for settlement requests.'
        : reason === 'minute-limit'
          ? `Twelve Data ${scope} per-minute request limit reached (${minuteLimit}/minute).`
          : 'Twelve Data credit reservation failed; request blocked (fail closed).';
    throw new TwelveDataBudgetError(reason, message, retryAfterMs);
  }
  return result;
}

/** Reserve one worker request; fail closed if the persistent guard is offline. */
export function reserveTwelveDataCredit() {
  return reserveCredit({
    scope: 'worker', rpc: 'reserve_twelvedata_credit',
    dailyLimit: config.twelveDataDailyCreditLimit,
    minuteLimit: config.twelveDataMinuteCreditLimit,
  });
}

/** Reserve one authenticated browser-relay request in its own persistent pool. */
export function reserveTwelveDataBrowserCredit(category = 'scan', scanReserve = 0) {
  const safeCategory = ['scan', 'ticker', 'settlement'].includes(category) ? category : 'scan';
  const safeScanReserve = Math.max(0, Math.min(
    config.twelveDataBrowserMinuteCreditLimit,
    Math.floor(Number(scanReserve) || 0),
  ));
  return reserveCredit({
    scope: 'browser', rpc: 'reserve_twelvedata_browser_credit',
    dailyLimit: config.twelveDataBrowserDailyCreditLimit,
    minuteLimit: config.twelveDataBrowserMinuteCreditLimit,
    extra: { p_category: safeCategory, p_scan_reserve: safeScanReserve },
  });
}
