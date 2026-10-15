// ── Telegram server-only transport + delivery retries ───────────────────
// The bot token and destinations are loaded only from the worker host env.
import { config, log, redactSecrets } from './config.js';
import { db, withJobLock } from './db.js';

const RELAY_METHODS = new Set(['sendMessage', 'sendSticker', 'getUpdates', 'setMyCommands']);

/** Call the limited Bot API methods used by NEXUS without exposing its token. */
export async function telegramApiCall(method, params = {}) {
  if (!config.telegramBotToken) return { ok: false, error: 'Telegram is not configured on the server' };
  if (!RELAY_METHODS.has(method)) return { ok: false, error: 'Telegram method is not allowed' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({}));
      if ((!res.ok || body.ok !== true) && res.status === 429 && attempt < 2) {
        const retrySeconds = Math.max(1, Math.min(30, Number(body.parameters && body.parameters.retry_after) || 2));
        await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
        continue;
      }
      if (!res.ok || body.ok !== true) {
        const description = redactSecrets(body.description || `HTTP ${res.status}`);
        return { ok: false, error: `Telegram ${res.status}: ${description.slice(0, 160)}` };
      }
      return { ok: true, result: body.result };
    } catch (err) {
      return { ok: false, error: redactSecrets(err && err.message || 'Telegram request failed').slice(0, 160) };
    }
  }
  return { ok: false, error: 'Telegram rate limit remains active; retry later' };
}

/** Send one server-owned destination message. */
export async function telegramSend(chatId, text, opts = {}) {
  if (!chatId) return { ok: false, error: 'Telegram destination is not configured' };
  const result = await telegramApiCall('sendMessage', {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    parse_mode: opts.parseMode || 'HTML',
    protect_content: opts.protectContent ?? true,
    disable_web_page_preview: true,
  });
  if (!result.ok) return result;
  return { ok: true, message_id: result.result && result.result.message_id };
}

/**
 * Retry pass: rows in ('retrying','failed') with attempts < max, plus any
 * 'pending' rows older than a minute (e.g. written by a crashed worker).
 * Bounded to 25 rows per pass. New browser records store channel aliases,
 * never private chat IDs; resolve those aliases only on the server.
 */
export async function runTelegramRetries(opts = {}) {
  const DBC = await (opts.db ?? db)();
  const send = opts.send ?? telegramSend;
  const now = opts.now ?? Date.now();
  const max = opts.max ?? config.telegramRetryMax;
  const { data: rows, error } = await DBC
    .from('telegram_deliveries')
    .select('id, chat_id, payload, status, attempts, message_kind, server_managed, last_attempt_at, first_attempt_at')
    .eq('server_managed', true)
    .in('status', ['retrying', 'failed', 'pending'])
    .lt('attempts', max)
    .order('created_at', { ascending: true })
    .limit(25);
  if (error) throw new Error(`retry query: ${error.message}`);
  if (!rows || !rows.length) return { retried: 0, sent: 0, still_failing: 0 };

  const stats = { retried: 0, sent: 0, still_failing: 0 };
  for (const row of rows) {
    // Defense in depth: never retry historical/untrusted rows or a fresh pending send.
    if (row.server_managed !== true) continue;
    if (row.status === 'pending' && now - Date.parse(row.last_attempt_at || row.first_attempt_at) < 60_000) continue;
    const storedDestination = String(row.chat_id || '');
    const destination = (Object.hasOwn(config.telegramChats, storedDestination) ? config.telegramChats[storedDestination] : '')
      || Object.values(config.telegramChats).find(value => value && value === storedDestination)
      || '';
    if (!destination || !row.payload) {
      const { error } = await DBC.from('telegram_deliveries').update({ status: 'skipped', last_error: 'missing/unknown configured destination or payload' }).eq('id', row.id);
      if (error) throw new Error('Telegram retry status persistence failed');
      continue;
    }
    stats.retried += 1;
    const r = await send(destination, row.payload, {
      protectContent: row.message_kind !== 'alert',
    });
    const nowIso = new Date().toISOString();
    if (r.ok) {
      stats.sent += 1;
      const { error } = await DBC.from('telegram_deliveries').update({
        status: 'sent', attempts: row.attempts + 1, telegram_message_id: String(r.message_id || ''),
        sent_at: nowIso, last_attempt_at: nowIso, last_error: null,
      }).eq('id', row.id);
      if (error) throw new Error('Telegram retry status persistence failed; inspect before retrying');
    } else {
      stats.still_failing += 1;
      const { error } = await DBC.from('telegram_deliveries').update({
        status: row.attempts + 1 >= max ? 'failed' : 'retrying',
        attempts: row.attempts + 1, last_attempt_at: nowIso, last_error: redactSecrets(r.error),
      }).eq('id', row.id);
      if (error) throw new Error('Telegram retry status persistence failed; inspect before retrying');
    }
  }
  if (stats.retried) log('info', 'telegram retries', stats);
  return stats;
}

export function telegramLocked() {
  return withJobLock('telegram-retry', 300, () => runTelegramRetries());
}
