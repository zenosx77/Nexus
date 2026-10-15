// Shared server-only Twelve Data client. API keys never leave this module/server.
import { config, redactSecrets } from './config.js';
import { reserveTwelveDataCredit, reserveTwelveDataBrowserCredit, TwelveDataBudgetError } from './credit-budget.js';

const API_BASE = 'https://api.twelvedata.com/';
const FAILURE_COOLDOWN_MS = 15 * 60_000;
export const providerHealth = Object.create(null);

function keyState(key) {
  if (!providerHealth[key]) {
    providerHealth[key] = { ok: true, failures: 0, lastOkAt: 0, cooldownUntil: 0, lastError: null };
  }
  return providerHealth[key];
}

export function markKeyFailure(key, err) {
  const st = keyState(key);
  st.ok = false;
  st.failures += 1;
  st.lastError = redactSecrets(err && err.message || err).slice(0, 160);
  st.cooldownUntil = Date.now() + Math.min(st.failures * 60_000, FAILURE_COOLDOWN_MS);
}

export function markKeySuccess(key) {
  const st = keyState(key);
  st.ok = true;
  st.failures = 0;
  st.lastOkAt = Date.now();
  st.cooldownUntil = 0;
  st.lastError = null;
}

export function providerHealthy() {
  const now = Date.now();
  const seen = Object.keys(providerHealth);
  if (seen.length) return seen.some(key => providerHealth[key].cooldownUntil <= now);
  return config.twelveDataKeys.length > 0;
}

export function providerStatus() {
  return {
    configured: config.twelveDataKeys.length > 0,
    keyCount: config.twelveDataKeys.length,
    healthy: providerHealthy(),
    coolingCount: config.twelveDataKeys.filter(key => keyState(key).cooldownUntil > Date.now()).length,
  };
}

function availableKey() {
  const now = Date.now();
  return config.twelveDataKeys.find(key => keyState(key).cooldownUntil <= now) || null;
}

function safeProviderError(status, body) {
  const detail = redactSecrets(body && body.message || `HTTP ${status}`).replace(/https?:\/\/\S+/gi, '[provider-url]');
  return new Error(`Twelve Data request failed (${status}): ${detail.slice(0, 180)}`);
}

function scrubProviderData(value) {
  if (Array.isArray(value)) return value.map(scrubProviderData);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSecrets(value) : value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api.?key|token|secret/i.test(key)) continue;
    safe[key] = scrubProviderData(item);
  }
  return safe;
}

/**
 * Call an allowlisted Twelve Data endpoint. `scope` selects the persistent
 * browser or worker request pool; api_usage is free and reserves no credits.
 * Returns { data, keyIndex } without ever returning the selected key.
 */
let jobCreditsRemaining = Infinity;
export function limitJobCredits(limit = 6) {
  jobCreditsRemaining = Math.max(0, Math.min(6, Math.floor(limit)));
}

export async function requestTwelveData(endpoint, params = {}, scope = 'worker', budgetOptions = {}, dependencies = {}) {
  if (!['time_series', 'quote', 'price', 'exchange_rate', 'api_usage'].includes(endpoint)) {
    throw new Error('Twelve Data operation is not allowed');
  }
  if (!config.twelveDataKeys.length) throw new Error('Twelve Data provider is not configured on the server');
  let lastError = 'provider unavailable';
  const maxAttempts = endpoint === 'api_usage' ? config.twelveDataKeys.length : config.twelveDataKeys.length;

  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt++) {
    const key = availableKey();
    if (!key) throw new Error(`all ${config.twelveDataKeys.length} provider keys are cooling down`);
    const keyIndex = config.twelveDataKeys.indexOf(key);
    if (endpoint !== 'api_usage') {
      if (scope === 'worker' && jobCreditsRemaining <= 0) throw new TwelveDataBudgetError('job-limit', 'Job paid-call cap reached');
      if (scope === 'browser') await reserveTwelveDataBrowserCredit(budgetOptions.category, budgetOptions.scanReserve, dependencies);
      else if (scope === 'worker') await reserveTwelveDataCredit(dependencies);
      else throw new Error('invalid Twelve Data budget scope');
    }

    if (endpoint !== 'api_usage' && scope === 'worker') jobCreditsRemaining--;
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(name, String(value));
    }
    query.set('apikey', key);
    const url = `${API_BASE}${endpoint}?${query.toString()}`;
    try {
      const response = await (dependencies.fetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === 'error') {
        const err = safeProviderError(response.status, body);
        markKeyFailure(key, err);
        lastError = err.message;
        continue;
      }
      markKeySuccess(key);
      return { data: scrubProviderData(body), keyIndex };
    } catch (err) {
      if (err instanceof TwelveDataBudgetError) throw err;
      markKeyFailure(key, err);
      lastError = redactSecrets(err && err.message || err).slice(0, 180);
    }
  }
  throw new Error(`Twelve Data provider unavailable: ${redactSecrets(lastError)}`);
}

/** Free account-usage lookup; returns masked aliases and never any key material. */
export async function getTwelveDataUsage() {
  if (!config.twelveDataKeys.length) return [];
  return Promise.all(config.twelveDataKeys.map(async (key, index) => {
    try {
      const response = await fetch(`${API_BASE}api_usage?apikey=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(12_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status === 'error') {
        return { key: `Server key ${index + 1}`, used: null, limit: null, error: 'usage lookup unavailable' };
      }
      const day = body && body.usage && body.usage.current_day || {};
      const usedRaw = day.credits_used ?? day.count ?? body.count;
      const limitRaw = day.credits_limit ?? day.limit ?? body.limit_daily;
      const used = Number(usedRaw), limit = Number(limitRaw);
      return {
        key: `Server key ${index + 1}`,
        used: Number.isFinite(used) ? used : null,
        limit: Number.isFinite(limit) ? limit : null,
        error: null,
      };
    } catch {
      return { key: `Server key ${index + 1}`, used: null, limit: null, error: 'network error' };
    }
  }));
}
