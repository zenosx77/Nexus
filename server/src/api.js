// ── Authenticated HTTP relay for browser-only features ──────────────────
// Runs beside the worker. All provider/bot credentials remain in process env.
import http from 'node:http';
import { config as defaultConfig, log, redactSecrets } from './config.js';
import { db as defaultDb } from './db.js';
import { requestTwelveData as defaultMarket, getTwelveDataUsage as defaultUsage, providerStatus as defaultProviderStatus } from './twelvedata.js';
import { TwelveDataBudgetError } from './credit-budget.js';
import { telegramApiCall as defaultTelegram } from './telegram.js';

const JSON_LIMIT = 32 * 1024;
const PAID_OPERATIONS = new Set(['time_series', 'quote', 'price', 'exchange_rate']);
const PARAMS_BY_OPERATION = {
  time_series: new Set(['symbol', 'interval', 'outputsize', 'start_date', 'end_date', 'timezone', 'dp']),
  quote: new Set(['symbol', 'interval', 'timezone', 'dp']),
  price: new Set(['symbol']),
  exchange_rate: new Set(['symbol', 'date']),
};
const SYMBOL_RE = /^[A-Z0-9]{3,12}(?:\/[A-Z0-9]{3,12})?$/;
const INTERVALS = new Set(['1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '1day']);
// Dependencies are per server instance for isolated offline HTTP tests. The CLI
// supplies no overrides and always uses real server-only transports.
export function createNexusApiServer(options = {}) {
  const config = options.config ?? defaultConfig;
  const db = options.db ?? defaultDb;
  const requestTwelveData = options.requestTwelveData ?? defaultMarket;
  const getTwelveDataUsage = options.getTwelveDataUsage ?? defaultUsage;
  const providerStatus = options.providerStatus ?? defaultProviderStatus;
  const telegramApiCall = options.telegramApiCall ?? defaultTelegram;
  const now = options.now ?? Date.now;
  const telegramChannelConfigured = channel => Object.hasOwn(config.telegramChats, channel)
    && Boolean(config.telegramBotToken && config.telegramChats[channel]);
  const buckets = new Map();

  function json(res, status, value, origin = '') {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(origin ? {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-expose-headers': 'retry-after',
        'access-control-max-age': '600',
        vary: 'Origin',
      } : {}),
    });
    res.end(body);
  }

  function exactOrigin(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && url.origin === value ? value : null;
    } catch { return null; }
  }

  function isAllowedOrigin(origin) {
    return Boolean(exactOrigin(origin) && config.allowedOrigins.includes(origin));
  }

  async function readJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
      throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > JSON_LIMIT) tooLarge = true;
      else if (!tooLarge) chunks.push(chunk);
    }
    if (tooLarge) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    let body;
    try { body = JSON.parse(text); }
    catch { throw Object.assign(new Error('Invalid JSON request body'), { statusCode: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('JSON request body must be an object'), { statusCode: 400 });
    }
    return body;
  }

  function rateAllowed(userId, kind, limit) {
    const time = now();
    const key = `${kind}:${userId}`;
    let bucket = buckets.get(key);
    if (!bucket || time - bucket.startedAt >= 60_000) {
      bucket = { startedAt: time, count: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    if (buckets.size > 10_000) {
      for (const [id, value] of buckets) if (time - value.startedAt >= 60_000) buckets.delete(id);
    }
    return true;
  }

  async function authenticatedUser(req) {
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!match) return null;
    const client = await db();
    const { data, error } = await client.auth.getUser(match[1]);
    if (error || !data?.user?.id || Date.parse(data.user.banned_until) > now()) return null;
    return data.user;
  }

  function validateMarketRequest(body) {
    const operation = String(body.operation || '');
    if (!PAID_OPERATIONS.has(operation)) throw Object.assign(new Error('Provider operation is not allowed'), { statusCode: 400 });
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
      throw Object.assign(new Error('Provider parameters are invalid'), { statusCode: 400 });
    }
    const params = {};
    for (const [name, value] of Object.entries(body.params)) {
      if (!PARAMS_BY_OPERATION[operation].has(name)) throw Object.assign(new Error(`Provider parameter is not allowed: ${name}`), { statusCode: 400 });
      if (typeof value !== 'string' && typeof value !== 'number') throw Object.assign(new Error(`Provider parameter is invalid: ${name}`), { statusCode: 400 });
      const text = String(value).trim();
      if (!text || text.length > 100 || /[\r\n]/.test(text)) throw Object.assign(new Error(`Provider parameter is invalid: ${name}`), { statusCode: 400 });
      params[name] = text;
    }
    if (!params.symbol || !SYMBOL_RE.test(params.symbol)) throw Object.assign(new Error('A valid provider symbol is required'), { statusCode: 400 });
    if (params.interval !== undefined && !INTERVALS.has(params.interval)) {
      throw Object.assign(new Error('Provider interval is not allowed'), { statusCode: 400 });
    }
    if (operation === 'time_series') {
      const interval = params.interval || '1min';
      if (!INTERVALS.has(interval)) throw Object.assign(new Error('Provider interval is not allowed'), { statusCode: 400 });
      params.interval = interval;
      const outputsize = Number(params.outputsize || 100);
      if (!Number.isInteger(outputsize) || outputsize < 1 || outputsize > 5000) {
        throw Object.assign(new Error('Provider outputsize must be between 1 and 5000'), { statusCode: 400 });
      }
      params.outputsize = outputsize;
    }
    if (params.dp !== undefined && (!/^\d{1,4}$/.test(params.dp) || Number(params.dp) > 15)) {
      throw Object.assign(new Error('Provider decimal precision is invalid'), { statusCode: 400 });
    }
    const category = ['scan', 'ticker', 'settlement'].includes(body.category) ? body.category : 'scan';
    const scanReserve = Number.isInteger(Number(body.scanReserve))
      ? Math.max(0, Math.min(config.twelveDataBrowserMinuteCreditLimit, Number(body.scanReserve))) : 0;
    return { operation, params, category, scanReserve };
  }

  function safeClientText(value, maxLength) {
    return redactSecrets(String(value || ''), maxLength)
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted Telegram token]')
      .replace(/\b[0-9a-f]{32}\b/gi, '[redacted provider key]')
      .slice(0, maxLength);
  }

  function telegramAliasForChat(chat) {
    if (!chat) return null;
    const chatId = String(chat.id ?? '');
    const username = chat.username ? `@${String(chat.username).toLowerCase()}` : '';
    for (const [alias, configured] of Object.entries(config.telegramChats)) {
      if (!configured) continue;
      if (String(configured) === chatId || String(configured).toLowerCase() === username) return alias;
    }
    return null;
  }

  function safeTelegramUpdate(update) {
    const safe = { update_id: update.update_id };
    for (const key of ['message', 'edited_message', 'channel_post', 'edited_channel_post']) {
      const message = update[key];
      if (!message) continue;
      const alias = telegramAliasForChat(message.chat);
      if (!alias) continue;
      safe[key] = {
        message_id: message.message_id,
        date: message.date,
        text: typeof message.text === 'string' ? safeClientText(message.text, 4096) : undefined,
        caption: typeof message.caption === 'string' ? safeClientText(message.caption, 1024) : undefined,
        from: message.from ? {
          is_bot: Boolean(message.from.is_bot),
          first_name: safeClientText(message.from.first_name || '', 100),
          username: message.from.username ? safeClientText(message.from.username, 64) : undefined,
        } : undefined,
        chat: { id: alias, type: message.chat.type, title: safeClientText(message.chat.title || '', 128) },
        reply_to_message: message.reply_to_message ? {
          message_id: message.reply_to_message.message_id,
          text: typeof message.reply_to_message.text === 'string' ? safeClientText(message.reply_to_message.text, 1024) : undefined,
        } : undefined,
        sticker: message.sticker ? {
          file_id: message.sticker.file_id,
          file_unique_id: message.sticker.file_unique_id,
          emoji: message.sticker.emoji,
        } : undefined,
      };
    }
    if (update.callback_query) {
      const callback = update.callback_query;
      const alias = telegramAliasForChat(callback.message && callback.message.chat);
      if (alias) safe.callback_query = {
        id: callback.id,
        data: typeof callback.data === 'string' ? safeClientText(callback.data, 256) : undefined,
        from: callback.from ? { username: safeClientText(callback.from.username || '', 64) } : undefined,
        message: {
          message_id: callback.message.message_id,
          chat: { id: alias, type: callback.message.chat.type },
        },
      };
    }
    return safe;
  }

  function safeTelegramResult(method, result, channel) {
    if (method === 'sendMessage' || method === 'sendSticker') {
      return { ok: true, result: { message_id: result && result.message_id, date: result && result.date, chat: { id: channel } } };
    }
    if (method === 'getUpdates') {
      const updates = Array.isArray(result) ? result.filter(update => update && Number.isInteger(update.update_id)).map(safeTelegramUpdate) : [];
      return { ok: true, result: updates };
    }
    if (method === 'setMyCommands') return { ok: true, result: Boolean(result) };
    return { ok: true };
  }

  async function recordTelegramDelivery(channel, text, result) {
    const attemptedAt = new Date().toISOString();
    const storedChannel = channel === 'admin' ? 'ops' : channel;
    const row = {
      channel: storedChannel,
      chat_id: channel,
      message_kind: 'other',
      status: result.ok ? 'sent' : 'failed',
      attempts: 1,
      telegram_message_id: result.ok && result.result && result.result.message_id != null
        ? String(result.result.message_id) : null,
      last_error: result.ok ? null : redactSecrets(result.error || 'Telegram send failed').slice(0, 200),
      payload: safeClientText(text, 4096),
      first_attempt_at: attemptedAt,
      last_attempt_at: attemptedAt,
      sent_at: result.ok ? attemptedAt : null,
      server_managed: true,
    };
    try {
      const client = await db();
      const { error } = await client.from('telegram_deliveries').insert(row);
      if (error) {
        log('warn', 'Telegram delivery record insert failed');
        return { recorded: false };
      }
      return { recorded: true };
    } catch {
      // Logging/retry persistence must not turn a successful Telegram send into a failed API response.
      log('warn', 'Telegram delivery record unavailable');
      return { recorded: false };
    }
  }

  async function routeTelegram(body, user) {
    if (!config.telegramAdminUserIds.includes(String(user.id))) {
      throw Object.assign(new Error('Telegram administration is not authorized for this account'), { statusCode: 403 });
    }
    const method = String(body.method || '');
    if (!['sendMessage', 'sendSticker', 'getUpdates', 'setMyCommands'].includes(method)) {
      throw Object.assign(new Error('Telegram method is not allowed'), { statusCode: 400 });
    }
    if (method === 'setMyCommands') {
      const commands = body.commands;
      if (!Array.isArray(commands) || commands.length > 100 || commands.some(command => !command || typeof command.command !== 'string' || !/^[a-z0-9_]{1,32}$/.test(command.command) || typeof command.description !== 'string' || command.description.length < 1 || command.description.length > 256)) {
        throw Object.assign(new Error('Telegram command list is invalid'), { statusCode: 400 });
      }
      const result = await telegramApiCall(method, { commands });
      if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: 502 });
      return safeTelegramResult(method, result.result);
    }

    if (method === 'getUpdates') {
      const offset = Number(body.offset || 0);
      const limit = Number(body.limit || 100);
      const timeout = Number(body.timeout || 0);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
          || !Number.isInteger(timeout) || timeout < 0 || timeout > 10) {
        throw Object.assign(new Error('Telegram polling parameters are invalid'), { statusCode: 400 });
      }
      const allowedUpdates = Array.isArray(body.allowed_updates)
        ? body.allowed_updates.filter(value => ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query'].includes(value))
        : ['message', 'channel_post', 'callback_query'];
      const result = await telegramApiCall(method, { offset, limit, timeout, allowed_updates: allowedUpdates });
      if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: 502 });
      return safeTelegramResult(method, result.result);
    }

    const channel = String(body.channel || '');
    const chatId = config.telegramChats[channel];
    if (!telegramChannelConfigured(channel)) {
      throw Object.assign(new Error('Telegram channel is not configured'), { statusCode: 400 });
    }
    let params;
    if (method === 'sendMessage') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4096) {
        throw Object.assign(new Error('Telegram message must contain 1–4096 characters'), { statusCode: 400 });
      }
      const text = safeClientText(body.text, 4096);
      if (!text) throw Object.assign(new Error('Telegram message must contain 1–4096 characters'), { statusCode: 400 });
      const parseMode = body.parse_mode === 'MarkdownV2' ? 'MarkdownV2' : body.parse_mode === 'HTML' ? 'HTML' : undefined;
      params = { chat_id: chatId, text, disable_web_page_preview: true, protect_content: body.protect_content !== false };
      if (parseMode) params.parse_mode = parseMode;
    } else {
      const sticker = typeof body.sticker === 'string' ? body.sticker : '';
      if (!sticker || sticker.length > 512 || /[\r\n]/.test(sticker)) throw Object.assign(new Error('Telegram sticker identifier is invalid'), { statusCode: 400 });
      params = { chat_id: chatId, sticker, protect_content: body.protect_content !== false };
    }
    const result = await telegramApiCall(method, params);
    let deliveryLog;
    if (method === 'sendMessage' && body.record_delivery === true) {
      deliveryLog = config.cloudSyncEnabled
        ? await recordTelegramDelivery(channel, params.text, result) : { recorded: false };
    }
    if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: 502, deliveryLog });
    return { ...safeTelegramResult(method, result.result, channel), ...(deliveryLog ? { deliveryLog } : {}) };
  }

  async function handle(req, res) {
    const origin = String(req.headers.origin || '');
    const corsOrigin = isAllowedOrigin(origin) ? origin : '';
    const url = new URL(req.url, 'http://nexus.local');
    const path = url.pathname;

    if (origin && !corsOrigin) return json(res, 403, { error: 'Origin is not allowed' });
    if (req.method === 'OPTIONS') {
      const requestedMethod = req.headers['access-control-request-method'];
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if ((requestedMethod && !['GET', 'POST'].includes(requestedMethod))
          || requestedHeaders.some(value => !['authorization', 'content-type'].includes(value))) {
        return json(res, 403, { error: 'CORS method or headers are not allowed' });
      }
      if (!corsOrigin) return json(res, 403, { error: 'Origin is not allowed' });
      res.writeHead(204, {
        'access-control-allow-origin': corsOrigin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        vary: 'Origin',
      });
      return res.end();
    }

    if (path === '/api/v1/health' && req.method === 'GET') {
      const provider = providerStatus();
      return json(res, 200, {
        ok: true,
        service: 'nexus-api',
        provider: { configured: provider.configured, healthy: provider.healthy, keyCount: provider.keyCount },
        telegram: {
          configured: Boolean(config.telegramBotToken),
          channels: Object.fromEntries(Object.keys(config.telegramChats).map(name => [name, telegramChannelConfigured(name)])),
        },
        browserBudget: {
          dailyLimit: config.twelveDataBrowserDailyCreditLimit,
          perMinuteLimit: config.twelveDataBrowserMinuteCreditLimit,
        },
      }, corsOrigin);
    }

    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' }, corsOrigin);
    if (!corsOrigin) return json(res, 403, { error: 'Allowed browser origin is required' });

    let user;
    try { user = await authenticatedUser(req); }
    catch {
      log('warn', 'API authentication service unavailable');
      return json(res, 503, { error: 'Authentication service unavailable' }, corsOrigin);
    }
    if (!user) return json(res, 401, { error: 'A valid NEXUS session is required' }, corsOrigin);

    if (path === '/api/v1/session' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        userId: user.id,
        telegramAdmin: config.telegramAdminUserIds.includes(String(user.id)),
        telegramConfigured: Boolean(config.telegramBotToken),
        telegramChannels: Object.fromEntries(Object.keys(config.telegramChats).map(name => [name, telegramChannelConfigured(name)])),
        cloudSyncEnabled: config.cloudSyncEnabled,
        modelSyncEnabled: config.cloudModelEnabled,
      }, corsOrigin);
    }

    if (path === '/api/v1/market' && req.method === 'POST') {
      if (!rateAllowed(user.id, 'market', config.apiUserRateLimitPerMinute)) {
        return json(res, 429, { error: 'NEXUS API rate limit reached; try again shortly' }, corsOrigin);
      }
      try {
        const body = await readJson(req);
        const request = validateMarketRequest(body);
        const result = await requestTwelveData(request.operation, request.params, 'browser', {
          category: request.category, scanReserve: request.scanReserve,
        });
        return json(res, 200, { data: result.data }, corsOrigin);
      } catch (err) {
        const status = err.statusCode || (err instanceof TwelveDataBudgetError ? 429 : 502);
        if (err instanceof TwelveDataBudgetError && err.retryAfterMs > 0) {
          res.setHeader('retry-after', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
        }
        return json(res, status, { error: redactSecrets(err.message).slice(0, 240), code: err.code || 'PROVIDER_RELAY_ERROR' }, corsOrigin);
      }
    }

    if (path === '/api/v1/usage' && req.method === 'GET') {
      if (!rateAllowed(user.id, 'usage', 10)) return json(res, 429, { error: 'Usage lookup rate limit reached' }, corsOrigin);
      const keys = await getTwelveDataUsage();
      return json(res, 200, { keys }, corsOrigin);
    }

    if (path === '/api/v1/telegram' && req.method === 'POST') {
      if (!rateAllowed(user.id, 'telegram', config.telegramRateLimitPerMinute)) {
        return json(res, 429, { error: 'Telegram relay rate limit reached' }, corsOrigin);
      }
      try {
        const body = await readJson(req);
        const result = await routeTelegram(body, user);
        return json(res, 200, result, corsOrigin);
      } catch (err) {
        const status = err.statusCode || 502;
        return json(res, status, { error: redactSecrets(err.message).slice(0, 240), ...(err.deliveryLog ? { deliveryLog: err.deliveryLog } : {}) }, corsOrigin);
      }
    }

    return json(res, 404, { error: 'API route not found' }, corsOrigin);
  }

  return http.createServer((req, res) => {
      handle(req, res).catch(err => {
        log('error', 'API request failed', err);
        if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
        else res.end();
      });
    });
}
