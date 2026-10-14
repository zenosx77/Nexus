// ── Candle validation (pure — unit-tested) ─────────────────────────────
// A candle is accepted only when it is a COMPLETED minute bar with sane
// OHLC. The ingestion layer never fabricates prices and never stores the
// still-forming candle.

export const MINUTE_MS = 60_000;

/**
 * Validate one raw provider candle.
 * @param {object} raw  { datetime, open, high, low, close, volume? } (Twelve Data shape, newest-first entries)
 * @param {object} opts { now?: number (ms), feedTzOffsetMin?: number }
 * @returns {{ok:true, ts:number, open:number, high:number, low:number, close:number, volume:number|null}
 *          |{ok:false, reason:string}}
 */
export function validateCandle(raw, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };
  const o = Number(raw.open), h = Number(raw.high), l = Number(raw.low), c = Number(raw.close);
  if (![o, h, l, c].every(v => Number.isFinite(v) && v > 0)) return { ok: false, reason: 'bad-prices' };
  if (h < l || h < o || h < c || l > o || l > c) return { ok: false, reason: 'ohlc-inconsistent' };
  const ts = typeof raw.ts === 'number' ? raw.ts : parseTs(raw.datetime);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'unparseable-datetime' };
  if (ts % MINUTE_MS !== 0) return { ok: false, reason: 'not-minute-aligned' };
  if (ts > now) return { ok: false, reason: 'future-timestamp' };
  // completed only: the candle's close time must have passed
  if (ts + MINUTE_MS > now) return { ok: false, reason: 'still-forming' };
  const v = raw.volume == null || raw.volume === '' ? null : Number(raw.volume);
  return { ok: true, ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : null };
}

/** Parse Twelve Data "YYYY-MM-DD HH:MM:SS" (assumed feed-local) or ISO strings → epoch ms. */
export function parseTs(datetime) {
  if (typeof datetime !== 'string') return NaN;
  const m = datetime.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  const t = Date.parse(datetime);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Detect gaps in a sorted ascending list of candle timestamps within [fromTs, toTs].
 * @returns {Array<{from:number,to:number,count:number}>} gap descriptors (minute-aligned)
 */
export function detectGaps(tsList, fromTs, toTs) {
  const gaps = [];
  let expected = Math.ceil(fromTs / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor(toTs / MINUTE_MS) * MINUTE_MS;
  const present = new Set(tsList.filter(t => t >= expected && t <= end));
  let gapStart = null;
  while (expected <= end) {
    if (!present.has(expected)) {
      if (gapStart == null) gapStart = expected;
    } else if (gapStart != null) {
      gaps.push({ from: gapStart, to: expected - MINUTE_MS, count: (expected - gapStart) / MINUTE_MS });
      gapStart = null;
    }
    expected += MINUTE_MS;
  }
  if (gapStart != null) gaps.push({ from: gapStart, to: end, count: (end - gapStart) / MINUTE_MS + 1 });
  return gaps;
}

/**
 * Compare a validated incoming candle against the stored one — detects revisions.
 * @returns {'new'|'duplicate'|'revised'}
 */
export function classifyAgainstStored(incoming, stored) {
  if (!stored) return 'new';
  const same = ['open', 'high', 'low', 'close'].every(k => Math.abs(incoming[k] - Number(stored[k])) < 1e-9);
  return same ? 'duplicate' : 'revised';
}
