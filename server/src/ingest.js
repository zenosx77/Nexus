// ── Market-data ingestion ───────────────────────────────────────────────
// Twelve Data 1-minute COMPLETED candles only. Never fabricates prices;
// when the provider fails, nothing is written and the failure is recorded.
// Provider health + quota cooldown per API key, gap backfill, duplicate and
// revision detection, staleness checks.

import { config, log } from './config.js';
import { db, upsertChunked, withJobLock } from './db.js';
import { reserveTwelveDataCredit, TwelveDataBudgetError, ingestBatchSize,
  recommendedIngestIntervalSeconds, nextUtcMidnightMs } from './credit-budget.js';
import { validateCandle, detectGaps, classifyAgainstStored, MINUTE_MS } from './validate.js';
import { computeFeatures } from './features.js';

const TF = '1m';   // market_candles.timeframe domain (see 0001_core.sql)

// ── provider health (in-memory; persisted per-run in ingestion_runs) ────
export const providerHealth = {
  // key → { ok, failures, lastOkAt, cooldownUntil, lastError }
};

function keyState(key) {
  if (!providerHealth[key]) {
    providerHealth[key] = { ok: true, failures: 0, lastOkAt: 0, cooldownUntil: 0, lastError: null };
  }
  return providerHealth[key];
}

function availableKey() {
  const now = Date.now();
  for (const key of config.twelveDataKeys) {
    if (keyState(key).cooldownUntil <= now) return key;
  }
  return null;
}

export function markKeyFailure(key, err) {
  const st = keyState(key);
  st.ok = false;
  st.failures += 1;
  st.lastError = String(err && err.message || err).slice(0, 300);
  st.cooldownUntil = Date.now() + Math.min(st.failures * 60_000, 15 * 60_000);  // backoff 1→15 min
}

export function markKeySuccess(key) {
  const st = keyState(key);
  st.ok = true; st.failures = 0; st.lastOkAt = Date.now(); st.cooldownUntil = 0; st.lastError = null;
}

export function providerHealthy() {
  const now = Date.now();
  const seen = Object.keys(providerHealth);
  if (seen.length) return seen.some(k => providerHealth[k].cooldownUntil <= now);
  return config.twelveDataKeys.length > 0;   // no failures recorded yet — optimistic
}

/** Fetch candles from Twelve Data with key rotation. Throws when all keys are cooling down. */
export async function fetchCandles(pairCode, outputsize = config.ingestOutputsize) {
  const symbol = pairCode.replace('/', '');                    // EUR/USD → EURUSD
  let lastErr = null;
  for (let attempt = 0; attempt < Math.max(1, config.twelveDataKeys.length); attempt++) {
    const key = availableKey();
    if (!key) throw new Error(`all ${config.twelveDataKeys.length} API keys in cooldown (last: ${lastErr})`);
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min`
      + `&outputsize=${outputsize}&apikey=${key}`;
    try {
      await reserveTwelveDataCredit();          // atomic persistent reservation, before any paid request
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === 'error') {
        const err = new Error(`twelvedata ${res.status}: ${body.message || 'HTTP error'}`);
        markKeyFailure(key, err);
        lastErr = err.message;
        continue;
      }
      const values = Array.isArray(body.values) ? body.values : [];
      if (!values.length) throw new Error(`twelvedata: no values for ${pairCode}`);
      markKeySuccess(key);
      return values;                                            // newest first
    } catch (err) {
      if (err instanceof TwelveDataBudgetError) throw err; // denied before provider access; do not cool down the key
      markKeyFailure(key, err);
      lastErr = err.message;
    }
  }
  throw new Error(`twelvedata fetch failed for ${pairCode}: ${lastErr}`);
}

/** Normalise provider rows → validated candles (order preserved, unsorted). */
export function normaliseAndValidate(values, now = Date.now()) {
  const out = { accepted: [], rejected: [] };
  for (const raw of values || []) {
    const v = validateCandle(raw, { now });
    if (v.ok) out.accepted.push({ ts: v.ts, open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume });
    else out.rejected.push(v.reason);
  }
  return out;
}

/** Ingest one pair: fetch → validate → classify vs stored → upsert → features → gap check. */
export async function ingestPair(pair, opts = {}) {
  const now = opts.now ?? Date.now();
  const run = {
    pair, fetched: 0, upserted: 0, duplicates: 0, revised: 0, gaps: 0,
    stale: false, latencyMs: null, error: null, gapList: [], budgetLimited: false, budgetReason: null,
  };
  let values;
  try {
    values = await fetchCandles(pair);
  } catch (err) {
    run.error = err.message;
    if (err instanceof TwelveDataBudgetError) {
      run.budgetLimited = true;
      run.budgetReason = err.reason;
    }
    return run;
  }
  run.fetched = values.length;

  const { accepted } = normaliseAndValidate(values, now);
  if (!accepted.length) { run.error = 'no valid candles in provider response'; return run; }
  accepted.sort((a, b) => a.ts - b.ts);
  const newest = accepted[accepted.length - 1];
  run.latencyMs = now - (newest.ts + MINUTE_MS);               // age of the newest closed candle
  run.stale = run.latencyMs > config.alerts.dataLagSeconds * 1000;

  // classify against stored (bounded query: only the window we fetched)
  const DBC = await db();
  const from = new Date(accepted[0].ts).toISOString();
  const to = new Date(newest.ts).toISOString();
  const { data: stored, error: qErr } = await DBC
    .from('market_candles')
    .select('ts, open, high, low, close')
    .eq('pair_code', pair)
    .eq('timeframe', TF)
    .gte('ts', from)
    .lte('ts', to);
  if (qErr) { run.error = `stored query: ${qErr.message}`; return run; }
  const storedMap = new Map((stored || []).map(r => [Date.parse(r.ts), r]));

  const rows = [];
  for (const c of accepted) {
    const cls = classifyAgainstStored(c, storedMap.get(c.ts));
    if (cls === 'duplicate') { run.duplicates += 1; continue; }
    if (cls === 'revised') run.revised += 1;
    rows.push({
      pair_code: pair, timeframe: TF, ts: new Date(c.ts).toISOString(),
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume, source: 'twelvedata', revised: cls === 'revised',
    });
  }
  if (rows.length) run.upserted = await upsertChunked('market_candles', rows, 'pair_code,timeframe,ts');

  // gaps within the fetched window (bounded by what we can see)
  const gapList = detectGaps(accepted.map(c => c.ts), accepted[0].ts, newest.ts);
  run.gapList = gapList;
  run.gaps = gapList.length;

  // feature snapshot (last 60 accepted candles)
  const snap = computeFeatures(accepted.slice(-60), { nowTs: newest.ts });
  if (snap) {
    const { error: fErr } = await DBC.from('market_features').upsert({
      pair_code: pair, timeframe: TF, ts: new Date(snap.ts).toISOString(),
      feature_version: snap.feature_version, features: snap.features,
    }, { onConflict: 'pair_code,timeframe,ts,feature_version' });
    if (fErr) log('warn', `features upsert failed for ${pair}`, fErr.message);
  }
  return run;
}

/** Backfill a gap for one pair using Twelve Data start_date paging. */
export async function backfillGap(pair, gap, opts = {}) {
  const now = opts.now ?? Date.now();
  const count = Math.min(gap.count, 5000);
  const symbol = pair.replace('/', '');
  const key = availableKey();
  if (!key) return { error: 'no API key available' };
  const start = new Date(gap.from).toISOString().replace(/:\d+\.\d+Z$/, '');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min`
    + `&start_date=${encodeURIComponent(start)}&outputsize=${count}&apikey=${key}`;
  try {
    await reserveTwelveDataCredit();            // backfills share the same persistent daily/minute caps
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === 'error') { markKeyFailure(key, body.message || res.status); return { error: body.message || `HTTP ${res.status}` }; }
    markKeySuccess(key);
    const { accepted } = normaliseAndValidate(body.values || [], now);
    const rows = accepted.map(c => ({
      pair_code: pair, timeframe: TF, ts: new Date(c.ts).toISOString(),
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume, source: 'twelvedata-backfill', revised: false,
    }));
    const upserted = rows.length ? await upsertChunked('market_candles', rows, 'pair_code,timeframe,ts') : 0;
    return { fetched: (body.values || []).length, upserted };
  } catch (err) {
    if (err instanceof TwelveDataBudgetError) {
      return { error: err.message, budgetLimited: true, budgetReason: err.reason };
    }
    markKeyFailure(key, err);
    return { error: err.message };
  }
}

/** Insert one ingestion_runs row (real column names from 0004_ops.sql). */
async function recordRun(kind, res) {
  const DBC = await db();
  const { error } = await DBC.from('ingestion_runs').insert({
    kind,
    pair_code: res.pair,
    status: res.error ? 'failed' : (res.upserted > 0 ? 'succeeded' : 'succeeded'),
    started_at: res.startedAt,
    finished_at: new Date().toISOString(),
    candles_fetched: res.fetched,
    candles_upserted: res.upserted,
    duplicates: res.duplicates,
    revised: res.revised,
    gaps_detected: res.gaps,
    gap_details: res.gapList && res.gapList.length ? res.gapList.map(g => ({
      from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString(), minutes: g.count,
    })) : null,
    latency_ms: res.latencyMs == null ? null : Math.round(res.latencyMs),
    error: res.error,
  });
  if (error) log('warn', `ingestion_runs insert failed for ${res.pair}`, error.message);
}

let activePairCache = { at: 0, pairs: null };
let lastLivePassAt = null;
let liveScheduleLoaded = false;
let livePairCursor = 0;

async function activePairs(DBC) {
  if (config.pairs) return [...config.pairs];
  if (activePairCache.pairs && Date.now() - activePairCache.at < 5 * 60_000) return [...activePairCache.pairs];
  const { data, error } = await DBC.from('currency_pairs').select('code').eq('is_active', true);
  if (error) throw new Error(`pairs query: ${error.message}`);
  activePairCache = { at: Date.now(), pairs: (data || []).map(r => r.code) };
  return [...activePairCache.pairs];
}

async function loadLiveSchedule(DBC, pairs) {
  if (liveScheduleLoaded) return;
  const { data, error } = await DBC.from('ingestion_runs')
    .select('pair_code, started_at').eq('kind', 'live')
    .order('started_at', { ascending: false }).limit(1);
  if (error) throw new Error(`latest ingestion run: ${error.message}`);
  const latest = data && data[0];
  lastLivePassAt = latest ? Date.parse(latest.started_at) : 0;
  if (latest && latest.pair_code) {
    const index = pairs.indexOf(latest.pair_code);
    if (index >= 0) livePairCursor = (index + 1) % Math.max(1, pairs.length);
  }
  liveScheduleLoaded = true;
}

/** Ingest a budget-sized rotating batch of pairs. Records each attempted pair. */
export async function ingestAll(kind = 'live') {
  const DBC = await db();
  const pairs = await activePairs(DBC);
  if (!pairs.length) return [];

  let batch = pairs;
  let startIndex = 0;
  if (kind === 'live') {
    await loadLiveSchedule(DBC, pairs);
    const batchSize = ingestBatchSize(pairs.length, config.twelveDataMinuteCreditLimit);
    const intervalSeconds = recommendedIngestIntervalSeconds(
      pairs.length, config.twelveDataDailyCreditLimit,
      config.twelveDataMinuteCreditLimit, config.ingestMinIntervalSeconds,
    );
    if (!batchSize || !Number.isFinite(intervalSeconds)) {
      log('warn', 'live ingestion paused by Twelve Data credit limits', {
        active_pairs: pairs.length, daily_limit: config.twelveDataDailyCreditLimit,
        per_minute_limit: config.twelveDataMinuteCreditLimit,
      });
      return [];
    }
    const now = Date.now();
    const waitMs = Math.max(0, lastLivePassAt + intervalSeconds * 1000 - now);
    if (waitMs > 0) {
      log('debug', `live ingestion deferred for ${Math.ceil(waitMs / 1000)}s to stay inside the daily credit budget`);
      return [];
    }
    startIndex = livePairCursor % pairs.length;
    batch = Array.from({ length: batchSize }, (_, i) => pairs[(startIndex + i) % pairs.length]);
    lastLivePassAt = now; // persisted ingestion_runs also restores cadence after a restart
    log('info', 'live ingestion credit schedule', {
      pairs_this_pass: batchSize, active_pairs: pairs.length,
      approximately_every_seconds: intervalSeconds,
      daily_limit: config.twelveDataDailyCreditLimit,
      reserved_for_backfill_and_retries_percent: 20,
    });
  }

  const results = [];
  let completed = 0;
  for (const pair of batch) {
    const startedAt = new Date().toISOString();
    const res = await ingestPair(pair);
    res.startedAt = startedAt;
    await recordRun(kind, res);
    results.push(res);
    log(res.error ? 'warn' : 'info', `ingest ${pair}`,
      res.error ? res.error : `fetched=${res.fetched} upserted=${res.upserted} dup=${res.duplicates} revised=${res.revised} gaps=${res.gaps} lag=${res.latencyMs == null ? '?' : Math.round(res.latencyMs / 1000) + 's'}`);
    if (res.budgetLimited) {
      if (res.budgetReason === 'daily-limit') lastLivePassAt = nextUtcMidnightMs();
      break; // no paid request was sent; stop this batch instead of probing every remaining pair
    }
    completed++;
  }
  if (kind === 'live') livePairCursor = (startIndex + completed) % pairs.length;
  return results;
}

/** Find and backfill gaps older than the current fetch window (scan last 24h, bounded). */
export async function backfillRecent(pairsOverride = null, lookbackHours = 24) {
  const DBC = await db();
  const pairs = pairsOverride ? [...pairsOverride] : await activePairs(DBC);
  const toTs = Date.now();
  const fromTs = toTs - lookbackHours * 3_600_000;
  const out = [];
  for (const pair of pairs) {
    const { data } = await DBC.from('market_candles')
      .select('ts').eq('pair_code', pair).eq('timeframe', TF)
      .gte('ts', new Date(fromTs).toISOString()).order('ts', { ascending: true });
    const gapList = detectGaps((data || []).map(r => Date.parse(r.ts)), fromTs, toTs - MINUTE_MS);
    for (const gap of gapList.filter(g => g.count >= 3)) {          // ignore 1–2 min blips
      const res = await backfillGap(pair, gap);
      out.push({ pair, gap, ...res });
      log(res.error ? 'warn' : 'info', `backfill ${pair} ${new Date(gap.from).toISOString()} (${gap.count}m)`,
        res.error ? res.error : `upserted=${res.upserted}`);
      if (res.budgetLimited) return out; // wait for the provider window/reset; don't probe more gaps
    }
  }
  return out;
}

/** Locked ingestion pass (used by the loop and the CLI). */
export async function runIngest(kind = 'live') {
  return withJobLock('ingest', 1800, async () => ingestAll(kind));
}

/** Locked backfill pass; share the same persistent credit guard as live ingestion. */
export async function backfillLocked(pairsOverride = null, lookbackHours = 24) {
  return withJobLock('backfill', 1800, async () => backfillRecent(pairsOverride, lookbackHours));
}
