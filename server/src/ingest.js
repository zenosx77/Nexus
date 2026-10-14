// ── Market-data ingestion ───────────────────────────────────────────────
// Twelve Data 1-minute COMPLETED candles only. Never fabricates prices;
// when the provider fails, nothing is written and the failure is recorded.
// Provider health + quota cooldown per API key, gap backfill, duplicate and
// revision detection, staleness checks.

import { config, log } from './config.js';
import { db, upsertChunked, withJobLock } from './db.js';
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
    stale: false, latencyMs: null, error: null, gapList: [],
  };
  let values;
  try {
    values = await fetchCandles(pair);
  } catch (err) {
    run.error = err.message;
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
    markKeyFailure(key, err);
    return { error: err.message };
  }
}

/** Insert one ingestion_runs row (real column names from 0004_ops.sql). */
async function recordRun(kind, res) {
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

/** Ingest all active pairs (or the configured subset). Records one ingestion_run row per pair. */
export async function ingestAll(kind = 'live') {
  let pairs = config.pairs;
  if (!pairs) {
    const { data, error } = await DBC.from('currency_pairs').select('code').eq('is_active', true);
    if (error) throw new Error(`pairs query: ${error.message}`);
    pairs = (data || []).map(r => r.code);
  }
  const results = [];
  for (const pair of pairs) {
    const startedAt = new Date().toISOString();
    const res = await ingestPair(pair);
    res.startedAt = startedAt;
    await recordRun(kind, res);
    results.push(res);
    log(res.error ? 'warn' : 'info', `ingest ${pair}`,
      res.error ? res.error : `fetched=${res.fetched} upserted=${res.upserted} dup=${res.duplicates} revised=${res.revised} gaps=${res.gaps} lag=${res.latencyMs == null ? '?' : Math.round(res.latencyMs / 1000) + 's'}`);
  }
  return results;
}

/** Find and backfill gaps older than the current fetch window (scan last 24h, bounded). */
export async function backfillRecent(pairsOverride = null, lookbackHours = 24) {
  let pairs = pairsOverride || config.pairs;
  if (!pairs) {
    const { data } = await DBC.from('currency_pairs').select('code').eq('is_active', true);
    pairs = (data || []).map(r => r.code);
  }
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
    }
  }
  return out;
}

/** One locked ingestion pass (used by the loop and the CLI). */
export async function runIngest(kind = 'live') {
  return withJobLock('ingest', 300, async () => ingestAll(kind));
}
