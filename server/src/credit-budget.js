// ── Twelve Data request budget ─────────────────────────────────────────
// Each one-symbol data request reserves one credit in Supabase before the
// provider is contacted. The reservation RPC is atomic and survives restarts.
// The api_usage endpoint is intentionally not routed through this module.

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

let dailyBlockedUntil = 0;

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

/** Reserve one paid Twelve Data request; fail closed if the guard is offline. */
export async function reserveTwelveDataCredit() {
  const now = Date.now();
  if (now < dailyBlockedUntil) {
    throw new TwelveDataBudgetError('daily-limit', 'Twelve Data daily credit limit reached; requests resume at 00:00 UTC.', dailyBlockedUntil - now);
  }

  let client;
  try {
    client = await db();
  } catch (err) {
    throw new TwelveDataBudgetError('guard-unavailable', `Twelve Data credit guard unavailable; request blocked: ${err.message}`);
  }

  let data, error;
  try {
    ({ data, error } = await client.rpc('reserve_twelvedata_credit', {
      p_daily_limit: config.twelveDataDailyCreditLimit,
      p_minute_limit: config.twelveDataMinuteCreditLimit,
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
    if (reason === 'daily-limit') dailyBlockedUntil = nextUtcMidnightMs(now);
    const message = reason === 'daily-limit'
      ? `Twelve Data daily credit limit reached (${config.twelveDataDailyCreditLimit}/UTC day); requests resume at 00:00 UTC.`
      : reason === 'minute-limit'
        ? `Twelve Data per-minute request limit reached (${config.twelveDataMinuteCreditLimit}/minute).`
        : 'Twelve Data credit reservation failed; request blocked (fail closed).';
    throw new TwelveDataBudgetError(reason, message, retryAfterMs);
  }
  return result;
}
