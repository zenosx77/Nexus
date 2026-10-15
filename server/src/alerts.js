// ── Operational alerts ──────────────────────────────────────────────────
// Independent of the dashboard: data lag, missing evaluations, delivery
// failures, and performance degradation. Deduplicated via alert_log
// (dedupe_key = kind:scope:hourBucket) so the ops chat never gets spammed.

import { config, log } from './config.js';
import { db } from './db.js';
import { telegramSend } from './telegram.js';

/** Record + (attempt to) deliver one alert. Returns true when newly raised. */
export async function raiseAlert(kind, severity, message, payload = {}, opts = {}) {
  const DBC = await db();
  const hourBucket = new Date(opts.now ?? Date.now()).toISOString().slice(0, 13);   // YYYY-MM-DDTHH
  const dedupeKey = `${kind}:${payload.scope || 'global'}:${hourBucket}`;

  // check-then-insert dedupe (races collapse into the unique index)
  const { data: existing } = await DBC.from('alert_log')
    .select('id').eq('dedupe_key', dedupeKey).limit(1);
  if (existing && existing.length) return false;

  const { error } = await DBC.from('alert_log').insert({
    kind, severity, dedupe_key: dedupeKey, message, payload, delivered: false,
  });
  if (error) {
    if (error.code === '23505') return false;                 // lost the race — fine
    log('warn', `alert insert failed (${kind})`, error.message);
    return false;
  }

  let delivered = false;
  if (config.telegramOpsChat) {
    const icon = severity === 'critical' ? '🔴' : '🟠';
    const r = await telegramSend(config.telegramOpsChat,
      `${icon} <b>NEXUS ops</b>\n${escapeHtml(message)}`, { parseMode: 'HTML' });
    delivered = r.ok;
  }
  await DBC.from('alert_log').update({ delivered }).eq('dedupe_key', dedupeKey);
  log(severity === 'critical' ? 'error' : 'warn', `alert ${kind}`, message);
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** All alert checks — one bounded pass. */
export async function runAlertChecks(opts = {}) {
  const DBC = await db();
  const now = opts.now ?? Date.now();
  const a = config.alerts;
  const raised = [];

  // 1. data lag: newest candle age per active pair (view is cheap)
  const { data: fresh } = await DBC.from('v_market_freshness').select('pair, is_active, age_seconds');
  for (const f of fresh || []) {
    if (!f.is_active) continue;
    if (f.age_seconds != null && f.age_seconds > a.dataLagSeconds) {
      const r = await raiseAlert('data-lag', 'warn',
        `${f.pair}: newest candle is ${Math.round(f.age_seconds)}s old (threshold ${a.dataLagSeconds}s)`,
        { scope: f.pair, age_seconds: f.age_seconds }, { now });
      if (r) raised.push(`data-lag:${f.pair}`);
    }
  }

  // 2. missing evaluations: predictions whose exit has long passed with no outcome
  const pendingCutoff = new Date(now - a.pendingEvalMinutes * 60_000).toISOString();
  const { count: pendingCount, error: pcErr } = await DBC
    .from('v_prediction_accuracy')
    .select('id', { count: 'exact', head: true })
    .is('outcome', null)
    .eq('is_shadow', false)
    .lt('target_open_ts', pendingCutoff);
  if (!pcErr && pendingCount > 20) {
    const r = await raiseAlert('missing-eval', 'warn',
      `${pendingCount} predictions older than ${a.pendingEvalMinutes}min still unevaluated`,
      { scope: 'global', count: pendingCount }, { now });
    if (r) raised.push('missing-eval');
  }

  // 3. delivery failures in the last hour
  const hourAgo = new Date(now - 3_600_000).toISOString();
  const { count: failedCount, error: fcErr } = await DBC
    .from('telegram_deliveries')
    .select('id', { count: 'exact', head: true })
    .in('status', ['failed', 'retrying'])
    .gte('last_attempt_at', hourAgo);
  if (!fcErr && failedCount >= a.failedDeliveries) {
    const r = await raiseAlert('delivery-failure', 'warn',
      `${failedCount} Telegram deliveries failing in the last hour (threshold ${a.failedDeliveries})`,
      { scope: 'telegram', count: failedCount }, { now });
    if (r) raised.push('delivery-failure');
  }

  // 4. performance degradation: w20 win rate floor + losing streaks
  const { data: snaps } = await DBC.from('risk_snapshots')
    .select('scope, window, win_rate, current_losing_streak, sample_size')
    .eq('window', 'w20').order('as_of', { ascending: false }).limit(200);
  const seen = new Set();
  for (const s of snaps || []) {
    if (seen.has(s.scope)) continue;
    seen.add(s.scope);
    if (s.sample_size < 20) continue;                       // not enough evidence yet
    if (s.win_rate != null && s.win_rate < a.winrateFloorW20) {
      const r = await raiseAlert('degradation', 'warn',
        `${s.scope}: w20 win rate ${(s.win_rate * 100).toFixed(1)}% below floor ${(a.winrateFloorW20 * 100).toFixed(0)}%`,
        { scope: s.scope, win_rate: s.win_rate }, { now });
      if (r) raised.push(`degradation:${s.scope}`);
    }
    if (s.current_losing_streak >= a.losingStreak) {
      const r = await raiseAlert('losing-streak', 'warn',
        `${s.scope}: ${s.current_losing_streak} consecutive losses (threshold ${a.losingStreak})`,
        { scope: s.scope, streak: s.current_losing_streak }, { now });
      if (r) raised.push(`losing-streak:${s.scope}`);
    }
  }

  return raised;
}
