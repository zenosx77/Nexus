// ── Telegram delivery retries (worker side) ─────────────────────────────
// The browser sends messages directly (existing behaviour, preserved) and
// records every completed attempt in telegram_deliveries. The worker retries
// rows the browser marked 'failed' — i.e. the Bot API explicitly rejected
// the send, so no message was delivered and a retry cannot double-send.
// Retries use the server-side bot token only.

import { config, log } from './config.js';
import { db, withJobLock } from './db.js';

/**
 * Send one message via the Bot API. Returns { ok, message_id, error }.
 * Never throws for API-level failures (returns ok:false instead).
 */
export async function telegramSend(chatId, text, opts = {}) {
  if (!config.telegramBotToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        parse_mode: opts.parseMode || 'HTML',
        protect_content: opts.protectContent ?? true,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok !== true) {
      return { ok: false, error: `telegram ${res.status}: ${body.description || 'error'}` };
    }
    return { ok: true, message_id: body.result && body.result.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Retry pass: rows in ('retrying','failed') with attempts < max, plus any
 * 'pending' rows older than a minute (e.g. written by a crashed worker).
 * Bounded to 25 rows per pass.
 */
export async function runTelegramRetries(opts = {}) {
  const DBC = await db();
  const max = opts.max ?? config.telegramRetryMax;
  const { data: rows, error } = await DBC
    .from('telegram_deliveries')
    .select('id, chat_id, payload, status, attempts, message_kind')
    .in('status', ['retrying', 'failed', 'pending'])
    .lt('attempts', max)
    .order('created_at', { ascending: true })
    .limit(25);
  if (error) throw new Error(`retry query: ${error.message}`);
  if (!rows || !rows.length) return { retried: 0, sent: 0, still_failing: 0 };

  const stats = { retried: 0, sent: 0, still_failing: 0 };
  for (const row of rows) {
    if (!row.chat_id || !row.payload) {
      await DBC.from('telegram_deliveries').update({ status: 'skipped', last_error: 'missing chat_id/payload' }).eq('id', row.id);
      continue;
    }
    stats.retried += 1;
    const r = await telegramSend(row.chat_id, row.payload, {
      protectContent: row.message_kind !== 'alert',
    });
    const nowIso = new Date().toISOString();
    if (r.ok) {
      stats.sent += 1;
      await DBC.from('telegram_deliveries').update({
        status: 'sent', attempts: row.attempts + 1, telegram_message_id: String(r.message_id || ''),
        sent_at: nowIso, last_attempt_at: nowIso, last_error: null,
      }).eq('id', row.id);
    } else {
      stats.still_failing += 1;
      await DBC.from('telegram_deliveries').update({
        status: row.attempts + 1 >= max ? 'failed' : 'retrying',
        attempts: row.attempts + 1, last_attempt_at: nowIso, last_error: r.error,
      }).eq('id', row.id);
    }
  }
  if (stats.retried) log('info', 'telegram retries', stats);
  return stats;
}

export function telegramLocked() {
  return withJobLock('telegram-retry', 300, () => runTelegramRetries());
}
