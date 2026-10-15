// ── Twelve Data request budgets ─────────────────────────────────────────
// Each paid one-symbol data request reserves one credit in Supabase before
// the provider is contacted. All scopes/keys share the atomic account guard.
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

export function sharedQuotaContract(result) {
  return result?.guard_version === 1 && result.account === 'twelvedata'
    && result.daily_limit === 700 && result.minute_limit === 6;
}

async function reserveCredit({ scope, dailyLimit, minuteLimit, extra = {} }, dependencies = {}) {
  const clock = dependencies.monotonicNow ?? (() => performance.now());
  const started = clock();
  let data;
  try {
    const client = await (dependencies.db ?? db)();
    const response = await client.rpc('reserve_twelvedata_account_credit', {
      p_scope: scope, p_daily_limit: dailyLimit, p_minute_limit: minuteLimit, ...extra,
    });
    if (response.error) throw new Error('reservation RPC failed');
    data = response.data;
  } catch {
    // Do not echo arbitrary database/transport error bodies (they may contain secrets).
    throw new TwelveDataBudgetError('guard-unavailable', 'Shared account quota unavailable; request blocked.');
  }
  const result = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (!sharedQuotaContract(result) || typeof result.allowed !== 'boolean') {
    throw new TwelveDataBudgetError('guard-unavailable', 'Shared account quota contract missing; request blocked.');
  }
  if (!result.allowed) {
    const reason = ['daily-limit', 'minute-limit', 'settlement-reserve'].includes(result.reason)
      ? result.reason : 'guard-unavailable';
    throw new TwelveDataBudgetError(reason, 'Shared account quota blocked request.', result.retry_after_ms);
  }
  const elapsed = clock() - started;
  if (result.reason !== 'reserved'
      || !Number.isInteger(result.daily_calls) || result.daily_calls < 1 || result.daily_calls > 700
      || !Number.isInteger(result.minute_calls) || result.minute_calls < 1 || result.minute_calls > 6
      || !Number.isFinite(elapsed) || !Number.isInteger(result.valid_for_ms) || result.valid_for_ms < 1 || result.valid_for_ms > 1000
      || elapsed < 0 || elapsed >= result.valid_for_ms) {
    // Ambiguous/slow reservations still count. Never refund/retry the reservation
    // or dispatch a stale permit, including across UTC midnight.
    throw new TwelveDataBudgetError('guard-unavailable', 'Shared quota reservation expired; request blocked.');
  }
  const assertFresh = () => {
    const age = clock() - started;
    if (!Number.isFinite(age) || age < 0 || age >= result.valid_for_ms) {
      throw new TwelveDataBudgetError('guard-unavailable', 'Shared quota reservation expired before dispatch.');
    }
  };
  return { ...result, assertFresh };
}

/** Reserve one worker request; fail closed if the persistent guard is offline. */
export function reserveTwelveDataCredit(dependencies = {}) {
  return reserveCredit({
    scope: 'worker',
    dailyLimit: config.twelveDataDailyCreditLimit,
    minuteLimit: config.twelveDataMinuteCreditLimit,
  }, dependencies);
}

/** Reserve one authenticated browser-relay request under the same account cap (plus scope sublimits). */
export function reserveTwelveDataBrowserCredit(category = 'scan', scanReserve = 0, dependencies = {}) {
  const safeCategory = ['scan', 'ticker', 'settlement'].includes(category) ? category : 'scan';
  const safeScanReserve = Math.max(0, Math.min(
    config.twelveDataBrowserMinuteCreditLimit,
    Math.floor(Number(scanReserve) || 0),
  ));
  return reserveCredit({
    scope: 'browser',
    dailyLimit: config.twelveDataBrowserDailyCreditLimit,
    minuteLimit: config.twelveDataBrowserMinuteCreditLimit,
    extra: { p_category: safeCategory, p_scan_reserve: safeScanReserve },
  }, dependencies);
}
