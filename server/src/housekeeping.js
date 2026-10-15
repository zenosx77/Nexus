// ── Retention, archival, lock sweeping ───────────────────────────────────
// Keeps 1-minute data bounded. Optional gzip archival to the private
// 'models' Storage bucket before pruning (concatenated gzip members —
// valid gzip, bounded memory).

import zlib from 'node:zlib';
import { config, log } from './config.js';
import { db, withJobLock } from './db.js';

/** Archive candles older than the retention cutoff for one pair → Storage. */
export async function archivePairCandles(pair, cutoffIso, opts = {}) {
  const DBC = await db();
  const chunkSize = opts.chunkSize ?? 5000;
  const members = [];
  let archived = 0;
  let cursor = null;
  // ascending, chunked, bounded per query
  for (;;) {
    let q = DBC.from('market_candles')
      .select('ts, open, high, low, close, volume, source, revised')
      .eq('pair_code', pair).eq('timeframe', '1m')
      .lt('ts', cutoffIso)
      .order('ts', { ascending: true })
      .limit(chunkSize);
    if (cursor) q = q.gt('ts', cursor);
    const { data, error } = await q;
    if (error) throw new Error(`archive query ${pair}: ${error.message}`);
    if (!data || !data.length) break;
    const lines = data.map(r => JSON.stringify([r.ts, r.open, r.high, r.low, r.close, r.volume, r.source, r.revised])).join('\n');
    members.push(zlib.gzipSync(Buffer.from(lines + '\n', 'utf8')));
    archived += data.length;
    cursor = data[data.length - 1].ts;
    if (data.length < chunkSize) break;
  }
  if (!archived) return { archived: 0, path: null };

  const day = new Date().toISOString().slice(0, 10);
  const path = `archive/${pair.replace('/', '-')}/candles-${day}.jsonl.gz`;
  const buf = Buffer.concat(members);
  const { error: upErr } = await DBC.storage.from('models').upload(path, buf, {
    contentType: 'application/gzip', upsert: true,
  });
  if (upErr) throw new Error(`archive upload ${pair}: ${upErr.message}`);
  return { archived, path };
}

/** Weekly housekeeping: sweep locks, prune logs/snapshots, archive + prune candles. */
export async function runHousekeeping(opts = {}) {
  const DBC = await db();
  const days = opts.days ?? config.retentionDays;
  const out = { riskPruned: 0, locksPruned: 0, logsPruned: 0, candlesArchived: 0, candlesPruned: 0, archives: [] };

  const r1 = await DBC.rpc('prune_risk_snapshots');
  out.riskPruned = r1.data ?? 0;
  const r2 = await DBC.rpc('prune_job_locks');
  out.locksPruned = r2.data ?? 0;
  const r3 = await DBC.rpc('prune_operational_logs', { p_days: 90 });
  out.logsPruned = r3.data ?? 0;

  if (config.archiveBeforePrune) {
    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data: pairs } = await DBC.from('currency_pairs').select('code').eq('is_active', true);
    for (const p of pairs || []) {
      try {
        const a = await archivePairCandles(p.code, cutoffIso);
        if (a.archived) { out.candlesArchived += a.archived; out.archives.push({ pair: p.code, ...a }); }
      } catch (err) {
        log('warn', `archive failed for ${p.code} — pruning skipped this cycle`, err.message);
        return out;                       // never prune data that failed to archive
      }
    }
  }
  const r4 = await DBC.rpc('prune_market_candles', { p_days: days });
  out.candlesPruned = r4.data ?? 0;
  log('info', 'housekeeping', out);
  return out;
}

export function housekeepingLocked() {
  return withJobLock('housekeeping', 1800, () => runHousekeeping());
}
