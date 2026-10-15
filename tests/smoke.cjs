// NEXUS Glass v5.2 Meridian — smoke + regression suite (jsdom).
// Run: npm install && npm test        (run it twice — the suite is idempotent)
// Covers: clean boot with 10 tabbed pages, multi-pair watchlist (10 pairs),
// server-only provider credentials, the authenticated relay + shared credit
// budget, candle-only parallel scans, quality-first
// signals (NONSTOP off by default), stable confirmed settlement (8-second revision window; no confirming-
// candle wait, ties = PUSH never a loss), 4-channel Telegram (MAIN/PUBLIC/VIP/
// LIST with fallback), PUBLIC 1-min stream (strict quality, sent before the
// candle opens), VIP best-shot stream (every 10 min, honest grade), SESSION
// engine (quality floor never decays → WIN sticker / honest loss → quality
// guard → completion + 2 outros), PREMIUM LIST engine (10-min live study →
// unique-pair slots 40–60 min ahead → verified result), per-event sticker bank with
// dedupe (no double stickers, nothing unassigned ever fires), bot-configured
// message formats (/setformat placeholders, saved permanently, premium emoji
// auto-normalized), Telegram save + authorization revocation, private-chat
// capture, public privacy filter, credit budget throttling, deep training +
// readiness, feed-clock timezone repair, manual news blackout, paper/
// signal-only guards, font + license assets, full DOM reference integrity,
// and the CLOUD SYNC Supabase mirror (offline degradation, anon-only writes,
// server-managed delivery audit, SHA-256-verified model apply, canonical JSON parity
// with the Python trainer).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const FILE = 'index.html';
const html = fs.readFileSync(FILE, 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
assert.equal(inline.length, 1, 'exactly one inline application script');

function boot(seedStorage, hooks) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://example.test/', runScripts: 'outside-only', virtualConsole: vc,
    beforeParse(w) {
      w.setInterval = () => 1;           // never fire timers during tests
      w.confirm = () => true;
      w.scrollTo = () => {};
      if (seedStorage) for (const [k, v] of Object.entries(seedStorage)) w.localStorage.setItem(k, v);
      if (hooks) hooks(w);
    },
  });
  const context = dom.getInternalVMContext();
  vm.runInContext(inline[0], context);
  const E = expr => vm.runInContext(expr, context);
  return { dom, w: dom.window, E, errors, doc: dom.window.document };
}

/* deterministic fresh candle payload, Twelve Data shape (newest first).
   Phase-shifted sine so the decision candle is never an exact doji. */
function candlePayload(n = 360, drift = 0) {
  const startMin = Math.floor(Date.now() / 60000) * 60000;
  const values = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(startMin - i * 60000);
    const dt = t.toISOString().slice(0, 19).replace('T', ' ');
    const p = 1.1 + 0.0009 * Math.sin(i / 9) + 0.0003 * Math.sin(i / 2.7) + 0.00022 * Math.sin(i / 1.9) + 0.00002 * Math.sin(i / 23) + drift * (n - i);
    const o = +p.toFixed(5), c = +(p + 0.00012 * Math.sin(i / 1.3 + 0.7)).toFixed(5);
    const h = +(Math.max(o, c) + 0.00006).toFixed(5), l = +(Math.min(o, c) - 0.00006).toFixed(5);
    values.push({ datetime: dt, open: String(o), high: String(h), low: String(l), close: String(c) });
  }
  return { values };
}
function jsonResponse(obj) { return { status: 200, ok: true, json: async () => obj }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function bodyObject(body) {
  if (body && typeof body === 'object') return body;
  try { return JSON.parse(String(body || '{}')); } catch (_) { return {}; }
}
const textOf = body => {
  const parsed=bodyObject(body);
  if(typeof parsed.text==='string') return parsed.text;
  try { return new URLSearchParams(String(body)).get('text') || ''; } catch (_) { return ''; }
};
const relayCall = (call, method) => String(call.url||'').includes('/api/v1/telegram') && bodyObject(call.body).method===method;
function enableRelay(E, options={}) {
  const channels=Object.assign({main:true,public:true,vip:true,list:true,admin:true},options.channels||{});
  const admin=options.admin!==false;
  E(`sbCfg={api:'https://relay.example.test',url:'https://nexus-test.supabase.co',anon:${JSON.stringify('A'.repeat(40))},record:${options.record!==false}};
    nexusApiEndpoint='https://relay.example.test';
    nexusApiSession={access_token:'test-session-token',refresh_token:'test-refresh-token',expires_at:Date.now()+3600000};
    nexusSessionInfo={ok:true,userId:'00000000-0000-4000-8000-000000000001',telegramAdmin:${admin},telegramConfigured:true,
      telegramChannels:${JSON.stringify(channels)},cloudSyncEnabled:true,modelSyncEnabled:true};
    nexusRelayHealth={provider:{configured:true,keyCount:2},browserBudget:{dailyLimit:700,perMinuteLimit:7}};`);
}
const M = 60000;

const { w, E, errors, doc, dom } = boot();
const $id = id => doc.getElementById(id);

/* inject a confirmed candle window so a pending target settles as a WIN for dir */
function injectWin(pair, targetT, dir, E) {
  const m1 = [];
  for (let k = -5; k <= 1; k++) {
    const ts = targetT + k * M;
    m1.push({ t: 'x', ts, o: 1.1, h: 1.2, l: 1.0, c: k === 0 ? (dir === 'CALL' ? 1.15 : 1.05) : 1.1 });
  }
  const m3 = [{ t: 'x', ts: targetT, o: 1.1, h: 1.2, l: 1.0, c: dir === 'CALL' ? 1.15 : 1.05 },
              { t: 'x', ts: targetT + 180000, o: 1.1, h: 1.2, l: 1.0, c: 1.1 }];
  E(`cache[${JSON.stringify(pair)}]={t:${targetT + 400000},latencyMs:5,m1:${JSON.stringify(m1)},m3:${JSON.stringify(m3)}}`);
}

async function main() {
  /* ── 1. clean boot ───────────────────────────────────────────── */
  assert.deepEqual(errors, [], 'application boots without DOM/runtime errors');

  /* ── 2. HTML/DOM reference integrity + page router ───────────── */
  const jsIds = new Set([...inline[0].matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  const missing = [...jsIds].filter(id => !$id(id));
  assert.deepEqual(missing, [], 'all JS-referenced element ids exist in the DOM');
  const fns = new Set([...html.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]));
  for (const fn of fns) assert.equal(E(`typeof ${fn}`), 'function', `onclick handler ${fn}() is defined`);
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    const h = a.getAttribute('href');
    if (h === '#') continue;                       // in-card action links
    assert.ok($id(h.slice(1)), `anchor target ${h} exists`);
  }
  const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dupIds = allIds.filter((v, i) => allIds.indexOf(v) !== i);
  assert.deepEqual([...new Set(dupIds)], [], 'no duplicate element ids');
  // every section lives on a page; tabs cover all pages
  assert.ok($id('pageTabs'), 'page tab bar present');
  assert.ok(doc.querySelectorAll('#pageTabs button').length >= 10, 'at least 10 page tabs');
  assert.deepEqual(E('JSON.stringify(PAGES)'), '["dash","sig","sess","vip","prem","bot","tg","res","brain","data","cloud"]');
  for (const p of E('PAGES')) assert.ok($id('page-' + p), `page ${p} exists`);
  for (const s of ['sec-keys', 'sec-usage', 'sec-feeds', 'sec-scan', 'sec-m1', 'sec-m3', 'sec-list', 'sec-sess', 'sec-vip',
                   'sec-bot', 'sec-tg', 'sec-pub', 'sec-paper', 'sec-stats', 'sec-perf', 'sec-brain', 'sec-hist', 'sec-bt',
                   'sec-live', 'sec-notif', 'sec-regime', 'sec-agents', 'sec-ready', 'sec-status',
                   'sec-sbcfg', 'sec-sbmodel', 'sec-sbperf', 'sec-sbfresh', 'sec-sbdeliv'])
    assert.ok($id(s), `section id ${s} exists`);
  // showPage switches exactly one page and persists
  E(`showPage('sess')`);
  assert.equal($id('page-sess').classList.contains('on'), true);
  assert.equal($id('page-dash').classList.contains('on'), false);
  assert.equal(w.localStorage.getItem('nx_page'), 'sess');
  assert.equal(doc.querySelector('#pageTabs button[data-page="sess"]').classList.contains('active'), true);
  E(`showPage('dash')`);
  assert.equal($id('page-dash').classList.contains('on'), true);
  E(`showPage('bogus')`);
  assert.equal($id('page-dash').classList.contains('on'), true, 'unknown page falls back to dash');

  /* ── 3. self-hosted font + license shipped with the site ─────── */
  assert.ok(html.includes("url('assets/fonts/inter-latin-wght-normal.woff2')"), '@font-face points at the self-hosted file');
  assert.ok(fs.existsSync('assets/fonts/inter-latin-wght-normal.woff2'), 'font file exists in repo');
  const lic = fs.readFileSync('assets/fonts/INTER-OFL-LICENSE.txt', 'utf8');
  assert.ok(lic.includes('SIL OPEN FONT LICENSE Version 1.1'), 'OFL 1.1 license included');
  assert.ok(lic.includes('Inter Project Authors'), 'license names the Inter authors');
  assert.ok(html.includes("font-src 'self'"), 'CSP allows self-hosted fonts only');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), 'no external font CDN references');
  // branding: the cheap straw-hat era is over
  assert.ok(!/Straw-Hat/i.test(html), 'old cheap branding removed');
  assert.ok(/Meridian/.test(html), 'v5 Meridian branding present');
  assert.ok((html.match(/<svg/g) || []).length >= 2, 'inline SVG logo + favicon shipped');
  assert.ok($id('commandPalette') && $id('commandSearch') && $id('cmdOpen'), 'Figma-style command palette controls render');
  assert.ok($id('netStatus') && $id('toTop') && $id('toastStack'), 'normal website utility controls render');
  assert.match(html, /prefers-reduced-motion/, 'motion design respects reduced-motion accessibility');
  assert.equal(E('QUICK_ACTIONS.length') >= 10, true, 'quick navigation and functional actions registered');
  E('commandOpen()'); assert.equal($id('commandPalette').classList.contains('on'), true, 'command palette opens');
  E(`renderCommandList('telegram')`); assert.ok($id('commandList').textContent.includes('Telegram'), 'command search filters actions');
  E('commandClose()'); assert.equal($id('commandPalette').classList.contains('on'), false, 'command palette closes');

  /* ── 4. multi-pair watchlist ─────────────────────────────────── */
  assert.equal(E('PAIRS.length'), 10, 'ten live pairs available');
  assert.equal(E('JSON.stringify(PAIRS[0])'), '"EUR/USD"');
  assert.equal($id('btPair').options.length, 10, 'backtest pair list covers all pairs');
  assert.equal(doc.querySelectorAll('#watch input').length, 10, 'watchlist renders every pair');
  assert.equal(doc.querySelectorAll('#watch input:checked').length, 3, 'three pairs ticked by default (quota-safe)');
  assert.deepEqual(E('JSON.stringify(watch())'), '["EUR/USD","GBP/USD","USD/JPY"]');
  const scanSrc = E('runScan.toString()');
  assert.ok(!/apiQuote|apiPrice|apiRate/.test(scanSrc), 'runScan never calls the diagnostic feeds');
  assert.ok(/apiTimeSeries/.test(scanSrc), 'runScan uses the candle feed');
  assert.ok(/Promise\.all/.test(scanSrc), 'pairs fetch in parallel (kills the sequential time lag)');
  assert.ok(/nextTargetFromFeed/.test(scanSrc), 'targets are keyed to the feed clock, not the device clock');

  /* ── 5. boot state + core primitives ─────────────────────────── */
  assert.equal(E('tgReady()'), false);
  assert.equal(E('tgMatchesChat({id:123})'), false);
  assert.equal(E('tzLabel()').startsWith('UTC'), true);
  assert.equal(E('candleOutcome("EUR/USD","M1","CALL",60000)'), null);
  assert.equal(E('keyPool().length'), 0, 'no real keys in the public build');
  assert.equal(E('px.status'), 'idle');
  assert.equal(E('sx.status'), 'idle');
  assert.equal(E('Object.keys(STRATS).length'), 26, '26 strategies in the ensemble');
  assert.equal(E('Object.keys(FAM).length'), 26, 'every strategy belongs to a family (weights stay finite)');
  assert.deepEqual(E('JSON.stringify(Object.keys(STRATS).filter(k=>!FAM[k]))'), '[]', 'no orphan strategies');
  assert.ok($id('liveRowsM1') && $id('liveRowsM3') && $id('predRows'));
  assert.match($id('liveRowsM1').textContent, /No live M1 signals yet/, 'M1 empty state');
  assert.match($id('liveRowsM3').textContent, /No live M3 signals yet/, 'M3 empty state');
  assert.equal(E('blackoutOn()'), false, 'news blackout defaults to OFF');
  assert.equal(E('nonstopOn()'), false, 'NONSTOP defaults to OFF — quality only (no low-grade signals)');
  assert.equal(E('budgetLevel()'), 0);
  assert.equal(E('budgetScanStep()'), 1);
  assert.equal(E('perMinCap()'), 7, 'conservative per-minute default is fixed, not multiplied by key count');
  assert.equal(E('perDayCap()'), 700, 'conservative daily default is fixed, not multiplied by key count');
  assert.ok($id('creditDailyLimit') && $id('creditMinuteLimit') && $id('saveCreditLimits'), 'editable daily and minute hard caps render');
  assert.equal(+$id('creditDailyLimit').value, 700);
  assert.equal(+$id('creditMinuteLimit').value, 7);
  assert.match($id('noteList').textContent, /Live feed/, 'notification centre never says "no trades" when empty');

  /* ── 6. server-only provider keys + API CREDIT USAGE ─────────── */
  assert.equal(doc.querySelectorAll('.kslot-row').length, 0, 'browser key-slot inputs are removed');
  assert.equal(doc.querySelectorAll('#keySlots input').length, 0, 'no provider-key field is rendered');
  assert.equal(E('typeof KEY_SLOTS'), 'undefined', 'browser key-slot pool retired');
  assert.equal(E('saveKeys()'), false, 'legacy key-save action refuses browser storage');
  assert.match($id('vaultMsg').textContent, /cannot be stored in this browser/i);
  assert.equal(w.localStorage.getItem('nx_keys10'), '', 'legacy ten-slot storage is cleared at boot');
  const legacyVault = boot({ nx_keys4: JSON.stringify(['old-a', 'old-b', '', '']), nx_keys10: JSON.stringify(['old-secret']) });
  assert.equal(legacyVault.E('keyPool().length'), 0, 'legacy browser provider keys are not restored');
  assert.equal(legacyVault.w.localStorage.getItem('nx_keys4'), '', 'legacy four-slot vault is cleared');
  assert.equal(legacyVault.w.localStorage.getItem('nx_keys10'), '', 'legacy ten-slot vault is cleared');
  legacyVault.w.close();
  $id('creditDailyLimit').value = '900'; $id('creditMinuteLimit').value = '5';
  assert.equal(E('saveCreditLimits()'), true, 'custom local secondary credit limits save');
  assert.equal(E('creditLimits.daily'), 900, 'the local preference is stored');
  assert.equal(E('perDayCap()'), 700, 'a local preference cannot raise the relay hard ceiling');
  assert.equal(E('perMinCap()'), 5);
  assert.equal(JSON.parse(w.localStorage.getItem('nx_credit_limits')).daily, 900, 'limits persist in this browser');
  E('resetCreditLimits()');
  assert.equal(E('perDayCap()'), 700); assert.equal(E('perMinCap()'), 7);
  // Relay configuration enables a sentinel server pool only; no provider key enters the browser.
  enableRelay(E);
  assert.equal(E('keyPool().length'), 1, 'configured server relay exposes one availability sentinel');
  assert.equal(E('keyPool()[0].src'), 'server');
  assert.equal(E('keyPool()[0].v'), undefined, 'no provider key material exists in the client pool');
  assert.ok(!E('JSON.stringify(sbCfg)').includes('TWELVEDATA'), 'browser cloud config contains no provider credentials');
  E('sbClear()');
  // API CREDIT USAGE parser remains tolerant of provider response shapes.
  assert.equal(E('JSON.stringify(parseUsage({usage:{current_day:{credits_used:12,credits_limit:800}}}))'), JSON.stringify({ used: 12, limit: 800 }), 'api_usage v1 shape parsed');
  assert.equal(E('JSON.stringify(parseUsage({count:7,limit_daily:800}))'), JSON.stringify({ used: 7, limit: 800 }), 'flat api_usage shape parsed');
  assert.equal(E('JSON.stringify(parseUsage({}))'), JSON.stringify({ used: null, limit: null }), 'unknown shape → nulls, never NaN');
  assert.ok($id('usageRows') && $id('usageSum') && $id('u_sess'), 'credit usage section renders');
  E('usageRows=[{key:"Server key 1",used:640,limit:800},{key:"Server key 2",used:5,limit:800}]; renderUsage()');
  assert.ok($id('usageSum').textContent.includes('645'), 'usage summary sums server-key aliases');
  assert.equal(doc.querySelectorAll('#usageRows .usage-row').length, 2, 'per-key usage rows render');

  /* ── 7. relay key pool + credit caps ─────────────────────────── */
  enableRelay(E);
  assert.equal(E('keyPool().length'), 1, 'server key availability does not reveal configured key count here');
  assert.deepEqual(E('JSON.stringify(keyPool()[0])'), '{"src":"server"}', 'browser receives no key value or rotation state');
  assert.equal(E('perMinCap()'), 7, 'server key count does not multiply the safe minute cap');
  assert.equal(E('perDayCap()'), 700, 'server key count does not multiply the safe daily cap');
  E('sbClear()');

  /* ── 8. stale / weekend candle rejection (pure gates) ────────── */
  assert.equal(E('isWeekendWindow(new Date("2026-10-14T12:00:00Z"))'), false, 'Wednesday: open');
  assert.equal(E('isWeekendWindow(new Date("2026-10-16T21:59:00Z"))'), false, 'Friday 21:59 UTC: open');
  assert.equal(E('isWeekendWindow(new Date("2026-10-16T22:01:00Z"))'), true, 'Friday 22:01 UTC: closed');
  assert.equal(E('isWeekendWindow(new Date("2026-10-17T12:00:00Z"))'), true, 'Saturday: closed');
  assert.equal(E('isWeekendWindow(new Date("2026-10-18T10:00:00Z"))'), true, 'Sunday morning: closed');
  assert.equal(E('isWeekendWindow(new Date("2026-10-18T23:00:00Z"))'), false, 'Sunday 23:00 UTC: open');
  const fresh = E(`(()=>{const m=[];const now=Date.now();const start=Math.floor(now/60000)*60000;
    for(let i=0;i<10;i++)m.push({ts:start-i*60000,o:1,h:1,l:1,c:1,t:"x"});return m.reverse();})()`);
  assert.equal(E('candleGate(' + JSON.stringify(fresh) + ').ok'), true, 'fresh candles pass the gate');
  const stale = fresh.map(b => ({ ...b, ts: b.ts - 10 * M }));
  const gStale = E('candleGate(' + JSON.stringify(stale) + ')');
  assert.equal(gStale.ok, false); assert.match(gStale.reason, /stale/i, 'stale candles rejected');
  const future = fresh.map(b => ({ ...b, ts: b.ts + 60 * M }));
  assert.match(E('candleGate(' + JSON.stringify(future) + ').reason'), /future/i, 'future timestamps rejected');
  const gWknd = E(`candleGate(${JSON.stringify(fresh)}, new Date("2026-10-17T12:00:00Z"))`);
  assert.equal(gWknd.ok, false); assert.match(gWknd.reason, /weekend/i, 'weekend candles rejected even if "fresh"');
  const vdGate = E(`validateSetup({dir:"CALL",conf:0.9,agree:4,conflict:0,channels:[]},{q:0.8},
    {thr:0.7,boost:{}},{doji:false,marketOpen:null,minScore:50,ttOpen:20,dataLagMs:0,score:80,grade:"A",
     gate:{ok:false,reason:"stale candles — test"}})`);
  assert.equal(vdGate.pass, false);
  assert.ok(vdGate.fails.some(f => /stale candles/.test(f)), 'gate reason surfaces in validation fails');

  /* ── 9. quality-first gates (session, confluence, ATR band, M5) ─ */
  assert.equal(E('sessionGate(new Date("2026-10-14T12:00:00Z")).ok'), true, 'London hours: active');
  assert.equal(E('sessionGate(new Date("2026-10-14T22:30:00Z")).ok'), false, '22:30 UTC: dead hours');
  assert.equal(E('sessionGate(new Date("2026-10-14T00:30:00Z")).ok'), false, '00:30 UTC: dead hours');
  assert.equal(E('sessionGate(new Date("2026-10-16T20:30:00Z")).ok'), false, 'Friday 20:30 UTC: closed');
  assert.equal(E(`famCount({"EMA 9/21 cross":"CALL","RSI-4 + BB confirm":"CALL","Donchian 20":"PUT"},"CALL")`), 2, 'family confluence counts distinct families');
  const vFam = E(`validateSetup({dir:"CALL",conf:0.9,agree:4,conflict:0,channels:[]},{q:0.8},{thr:0.7,boost:{}},
    {doji:false,marketOpen:null,minScore:50,ttOpen:20,dataLagMs:0,score:85,grade:"A",famN:1,atrPct:0.6})`);
  assert.equal(vFam.pass, false); assert.ok(vFam.fails.some(f => /single-family/.test(f)), 'single-family vote rejected');
  const vAtr = E(`validateSetup({dir:"CALL",conf:0.9,agree:4,conflict:0,channels:[]},{q:0.8},{thr:0.7,boost:{}},
    {doji:false,marketOpen:null,minScore:50,ttOpen:20,dataLagMs:0,score:85,grade:"A",famN:3,atrPct:0.2})`);
  assert.ok(vAtr.fails.some(f => /ATR percentile/.test(f)), 'ATR band gate rejects too-quiet markets');
  const vM5 = E(`validateSetup({dir:"CALL",conf:0.9,agree:4,conflict:0,channels:[]},{q:0.8},{thr:0.7,boost:{}},
    {doji:false,marketOpen:null,minScore:50,ttOpen:20,dataLagMs:0,score:85,grade:"A",famN:3,atrPct:0.6,m5:"PUT"})`);
  assert.ok(vM5.fails.some(f => /M5 bias conflict/.test(f)), 'M5 confirmation veto works');
  const vSess = E(`validateSetup({dir:"CALL",conf:0.9,agree:4,conflict:0,channels:[]},{q:0.8},{thr:0.7,boost:{}},
    {doji:false,marketOpen:null,minScore:50,ttOpen:20,dataLagMs:0,score:85,grade:"A",famN:3,atrPct:0.6,sessOk:false,sessReason:"dead session hours"})`);
  assert.ok(vSess.fails.some(f => /dead session/.test(f)), 'session gate blocks signals');

  /* ── 10. lead time: prediction lands in the PREVIOUS minute ───── */
  assert.equal($id('leadSec').value, '40', 'default lead 40s leaves Telegram delivery headroom');
  $id('leadSec').value = '45';
  assert.equal(E('leadSecOf()'), 45);
  assert.equal(E('shouldAutoFire(45,29,28,45,false)'), true, 'fires at 45s left with lead 45');
  assert.equal(E('shouldAutoFire(46,29,28,45,false)'), false, 'not before the lead window');
  assert.equal(E('shouldAutoFire(45,29,29,45,false)'), false, 'one fire per minute');
  assert.equal(E('shouldAutoFire(45,29,28,45,true)'), false, 'never double-scan while busy');
  $id('leadSec').value = '30';

  /* ── 11. confirmed settlement math (the win-shown-as-loss fix) ── */
  const now0 = Math.floor(Date.now() / M) * M;
  assert.equal(E(`nextTargetFromFeed(${now0 + 30000},60000)`), now0 + M, 'feed-keyed target: next minute open');
  assert.equal(E(`nextTargetFromFeed(${now0},180000)`), Math.floor(now0 / 180000) * 180000 + 180000, 'feed-keyed M3 target');
  E(`cache['EUR/USD']={t:${now0 + 2 * M},latencyMs:10,m1:[
      {t:'a',ts:${now0 - M},o:1.1,h:1.2,l:1.0,c:1.15},
      {t:'b',ts:${now0},o:1.10,h:1.20,l:1.05,c:1.18},
      {t:'c',ts:${now0 + M},o:1.18,h:1.19,l:1.17,c:1.185}],m3:[]}`);
  let oc = E(`candleOutcome('EUR/USD','M1','CALL',${now0})`);
  assert.equal(oc.win, true, 'CALL wins when close > open');
  assert.equal(oc.push, false);
  oc = E(`candleOutcome('EUR/USD','M1','PUT',${now0})`);
  assert.equal(oc.win, false, 'PUT loses on the same candle');
  E(`cache['EUR/USD'].m1[1]={t:'b',ts:${now0},o:1.10,h:1.20,l:1.05,c:1.10}`);
  oc = E(`candleOutcome('EUR/USD','M1','PUT',${now0})`);
  assert.equal(oc.push, true, 'close == open is a PUSH (tie) — never counted as a loss');
  assert.equal(oc.win, null);
  E(`cache['EUR/USD'].t=${now0 + M - 1000}`);
  assert.equal(E(`candleOutcome('EUR/USD','M1','CALL',${now0})`), null, 'NO verdict from a snapshot taken before the candle closed');
  E(`cache['EUR/USD'].t=${now0 + M + 900}`);
  assert.equal(E(`candleOutcome('EUR/USD','M1','CALL',${now0})`), null, 'provider revision window blocks a provisional verdict');
  E(`cache['EUR/USD'].t=${now0 + M + 9000}`);
  assert.notEqual(E(`candleOutcome('EUR/USD','M1','CALL',${now0})`), null, 'stable snapshot after the close settles without verdict flipping');
  E(`cache['EUR/USD'].t=${now0 + M - 1000}`);
  E(`cache['EUR/USD']={t:${now0 + 2 * M + 9000},latencyMs:10,m1:[
      {t:'a',ts:${now0},o:1.1,h:1.2,l:1.0,c:1.15},
      {t:'b',ts:${now0 + M},o:1.15,h:1.2,l:1.1,c:1.16}],m3:[]}`);
  oc = E(`candleOutcome('EUR/USD','M1','CALL',${now0 + M})`);
  assert.notEqual(oc, null, 'FAST SETTLEMENT: the just-closed candle settles WITHOUT waiting for a newer confirming candle');
  assert.equal(oc.win, true, 'and it settles correctly (CALL wins on a rising candle)');
  E('cache={}');

  /* ── 11b. paper-validation production gate ───────────────────── */
  const pg0 = E('productionGate()');
  assert.equal(pg0.ok, false, 'new installations keep Telegram production locked');
  assert.ok(pg0.reasons.some(r => /100/.test(r)), 'gate explains the 100-outcome requirement');
  assert.equal(E('wilsonLower(70,100,1.96) < 0.70'), true, 'gate uses a conservative lower confidence bound');
  const pgReady = E(`(()=>{const oldH=histRows,oldD=deep.M1;
    histRows=Array.from({length:100},(_,i)=>({res:i<80?'win':'loss'}));
    deep.M1={ensVn:60,ensVwr:.68}; const g=productionGate(); histRows=oldH;deep.M1=oldD;return g;})()`);
  assert.equal(pgReady.ok, true, 'sufficient confirmed + statistical + deep evidence unlocks production');

  /* ── 11c. real browser Auth/relay transport, not pre-seeded session shortcuts ─ */
  {
    const isolated=boot();
    const requests=[];
    isolated.E(`sbCfg={api:'https://relay.example.test',url:'https://nexus-test.supabase.co',anon:'${'A'.repeat(40)}',record:true};
      nexusApiEndpoint=sbCfg.api; nexusSessionStorageClear();`);
    isolated.w.fetch=async(url,opts)=>{
      const u=String(url); requests.push({url:u,opts});
      if(u.endsWith('/auth/v1/signup')) return jsonResponse({access_token:'fresh-auth',refresh_token:'fresh-refresh',expires_in:3600});
      if(u.includes('/auth/v1/token?grant_type=refresh_token')) return jsonResponse({access_token:'refreshed-auth',refresh_token:'next-refresh',expires_in:3600});
      if(u.endsWith('/api/v1/session')) return jsonResponse({ok:true,userId:'test-user',telegramAdmin:false,telegramChannels:{}});
      if(u.endsWith('/api/v1/market')) return jsonResponse({data:{price:'1.1'}});
      throw new Error('Unexpected browser network target: '+u);
    };
    const first=await isolated.E(`jget(BASE+'price?symbol=EUR%2FUSD&apikey=legacy-must-not-forward',null,'scan')`);
    assert.equal(first.price,'1.1');
    assert.equal(requests[0].url,'https://nexus-test.supabase.co/auth/v1/signup');
    assert.equal(requests[0].opts.headers.apikey,'A'.repeat(40));
    const paid=requests.find(r=>r.url.endsWith('/api/v1/market'));
    assert.equal(paid.opts.headers.authorization,'Bearer fresh-auth');
    assert.equal(paid.opts.headers['content-type'],'application/json');
    const payload=JSON.parse(paid.opts.body);
    assert.equal(payload.operation,'price'); assert.equal(payload.params.symbol,'EUR/USD');
    assert.equal(payload.params.apikey,undefined,'legacy URL key is stripped before transport');
    assert.ok(!String(isolated.w.localStorage.getItem('nx_sb')).includes('fresh-auth'),'bearer not stored in public configuration');
    assert.equal(JSON.parse(isolated.w.sessionStorage.getItem(isolated.E('NEXUS_SESSION_KEY'))).access_token,'fresh-auth');
    // A restored unexpired session must retain its real expiry, not gain an hour on reload.
    const expiry=Date.now()+120000;
    isolated.E(`nexusApiSession.expires_at=${expiry}; nexusSessionInfo=null`);
    await isolated.E('ensureNexusSession()');
    assert.equal(isolated.E('nexusApiSession.expires_at'),expiry);
    isolated.E('nexusApiSession.expires_at=0; nexusSessionInfo=null');
    await isolated.E('ensureNexusSession()');
    const refresh=requests.find(r=>r.url.includes('grant_type=refresh_token'));
    assert.equal(JSON.parse(refresh.opts.body).refresh_token,'fresh-refresh');
    assert.equal(isolated.E('nexusApiSession.access_token'),'refreshed-auth');
    assert.ok(!requests.some(r=>/api\.twelvedata\.com|api\.telegram\.org/.test(r.url)));
    // Failed refresh and failed anonymous sign-in cannot reach a paid route.
    isolated.E('nexusApiSession.expires_at=0; nexusSessionInfo=null');
    const deniedTargets=[];
    isolated.w.fetch=async url=>{ deniedTargets.push(String(url)); return {ok:false,status:401,json:async()=>({error:'denied'})}; };
    await assert.rejects(isolated.E("jget(BASE+'price?symbol=EUR%2FUSD',null,'scan')"), /anonymous sign-in failed/);
    assert.equal(deniedTargets.some(url=>url.endsWith('/api/v1/market')),false);
    assert.equal(isolated.w.sessionStorage.getItem(isolated.E('NEXUS_SESSION_KEY')),null);
    isolated.w.close();
  }

  /* ── 12. Telegram transport authorization via the server relay ─ */
  let calls = 0, lastUrl = '', telegramRequest = null, relayHeaders = null, auditRecorded = true;
  w.fetch = async (url, opts) => {
    calls++; lastUrl=String(url);
    telegramRequest=bodyObject(opts&&opts.body); relayHeaders=opts.headers;
    return jsonResponse({ok:true,result:{message_id:42,date:Date.now(),chat:{id:telegramRequest.channel||'main'}},deliveryLog:{recorded:auditRecorded}});
  };
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"main",text:"hi"})'), /not authorized/);
  assert.equal(calls, 0, 'no unauthenticated network send');
  enableRelay(E);
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"main",text:"hi"})'), /not authorized/);
  assert.equal(calls, 0, 'relay session alone does not authorize Telegram output');
  E('tg.auth=true');
  assert.equal(E('tgReady()'), true, 'allowlisted Auth session plus local authorization enables output');
  assert.equal(E('tgMatchesChat({id:"main"})'), true, 'server-approved channel alias is accepted');
  assert.equal(E('tgMatchesChat({id:"admin"})'), true, 'server-approved admin alias is accepted');
  assert.equal(E('tgMatchesChat({id:"123456789"})'), false, 'raw/private chat IDs never reach the browser');
  assert.equal(E('tgMatchesChat({id:"unknown",type:"channel"})'), false, 'unconfigured channels are isolated');
  const sent=await E('tgCall("sendMessage",{chat_id:"main",text:"hi"})');
  assert.equal(calls, 1);
  assert.ok(lastUrl.endsWith('/api/v1/telegram'), 'Telegram operations use the authenticated relay');
  assert.ok(!lastUrl.includes('api.telegram.org'), 'browser never calls the Bot API host');
  assert.equal(relayHeaders.authorization,'Bearer test-session-token', 'relay send carries the Supabase Auth bearer');
  assert.equal(relayHeaders['content-type'],'application/json', 'relay sends JSON, not legacy Bot form data');
  assert.equal(telegramRequest.method,'sendMessage');
  assert.equal(telegramRequest.channel,'main');
  assert.equal(telegramRequest.text,'hi');
  assert.equal(telegramRequest.record_delivery,true, 'delivery logging is requested only as a server-side operation');
  assert.equal(Object.hasOwn(telegramRequest,'chat_id'),false, 'private chat ID is not sent by the browser');
  assert.equal(JSON.stringify(telegramRequest).includes('test-session-token'),false, 'bearer token is never included in the Telegram body');
  assert.equal(sent.message_id,42, 'relay returns a safe message result');
  auditRecorded=false; const beforeAuditWarning=calls;
  await E('tgCall("sendMessage",{chat_id:"main",text:"audit test"})');
  assert.equal(calls,beforeAuditWarning+1, 'failed audit persistence must never trigger a duplicate send');
  assert.ok(E('tg.log.some(line=>line.includes("delivery audit was not persisted"))'), 'browser surfaces audit persistence warning');
  auditRecorded=true;

  /* ── 13. Telegram preferences contain only display settings ──── */
  E('tg.auth=false');
  $id('tgBrand').value='BRANDX';
  assert.equal(E('tgSaveSettings()'),true);
  assert.equal(E('tg.brand'),'BRANDX');
  const savedTg=w.localStorage.getItem('nx_tg');
  assert.ok(savedTg.includes('BRANDX'),'display setting persisted to browser storage');
  assert.ok(!/test-token|chatId|mainChat|pubChat|vipChat|listChat|123456789/.test(savedTg), 'Telegram tokens and destinations are not stored');
  assert.equal($id('tgToken'),null, 'browser token input is removed');
  assert.equal($id('tgChat'),null, 'browser destination input is removed');
  E('tg.auth=true');
  const before=calls;
  E('tg.auth=false');
  await assert.rejects(E('tgSend("hi")'),/not authorized/i);
  assert.equal(calls,before,'revoked browser authorization blocks sends');
  enableRelay(E,{admin:false}); E('tg.auth=true');
  assert.equal(E('tgReady()'),false, 'a session outside the server admin allowlist cannot send');
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"main",text:"blocked"})'),/not authorized/);
  enableRelay(E); E('tg.auth=true');

  /* ── 13b. server-configured channel aliases + fallback ───────── */
  enableRelay(E,{channels:{main:true,public:false,vip:true,list:false,admin:true}});
  assert.equal(E('chatFor("main")'),'main','MAIN resolves to its alias');
  assert.equal(E('chatFor("pub")'),'','unconfigured PUBLIC destination is not sent as a raw ID');
  assert.equal(E('chatFor("vip")'),'vip','VIP resolves to its server alias');
  assert.equal(E('chatFor("list")'),'','unconfigured LIST destination is not sent as a raw ID');
  assert.match(E('chatLabel("vip")'),/VIP: server configured/,'channel labels expose readiness, not private IDs');
  enableRelay(E); E('tg.auth=true');

  /* ── 14. sticker bank: one per event, dedupe, nothing unassigned fires ── */
  const tgCalls = [];
  w.fetch = async (url, opts) => {
    calls++; const body=String((opts&&opts.body)||''); const request=bodyObject(body);
    tgCalls.push({url:String(url),body,method:request.method,channel:request.channel});
    return jsonResponse({ok:true,result:{message_id:43,date:Date.now(),chat:{id:request.channel||'main'}}});
  };
  enableRelay(E); E('tg.auth=true');
  assert.equal(E('JSON.stringify(STK_ROLES.map(r=>r.id))'),
    JSON.stringify(['session', 'win', 'loss', 'push', 'vip', 'list', 'result', 'outro1', 'outro2']), 'nine assignable event roles');
  // unassigned role → NEVER sends (no unauthorized stickers)
  tgCalls.length = 0;
  assert.equal(await E(`tgSticker('vip','main','t1')`), false, 'unassigned role sends nothing');
  assert.equal(tgCalls.filter(c => relayCall(c,'sendSticker')).length, 0, 'zero sticker calls for unassigned roles');
  E(`stPending.length=0;
     stPending.push({file_id:'F_SESS',label:'s'},{file_id:'F_W1',label:'w1'},{file_id:'F_W2',label:'w2'},
       {file_id:'F_LOSS',label:'l'},{file_id:'F_VIP',label:'v'},{file_id:'F_LIST',label:'li'},
       {file_id:'F_RES',label:'r'},{file_id:'F_O1',label:'o1'},{file_id:'F_O2',label:'o2'});`);
  E(`assignSticker(0,'session');assignSticker(0,'win');assignSticker(0,'win');assignSticker(0,'loss');
     assignSticker(0,'vip');assignSticker(0,'list');assignSticker(0,'result');assignSticker(0,'outro1');assignSticker(0,'outro2')`);
  assert.equal(E('tg.stk.session'), 'F_SESS');
  assert.deepEqual(E('JSON.stringify(tg.stk.win)'), '["F_W1","F_W2"]', 'multiple stickers in the win bank');
  assert.equal(E('tg.stk.loss'), 'F_LOSS');
  assert.equal(E('tg.stk.outro1'), 'F_O1'); assert.equal(E('tg.stk.outro2'), 'F_O2');
  assert.equal(E('stPending.length'), 0, 'pending queue drained');
  for (let i = 0; i < 20; i++) {
    const pick = E("stkPick('win')");
    assert.ok(pick === 'F_W1' || pick === 'F_W2', 'random win sticker comes ONLY from the win bank');
  }
  assert.ok($id('stInfo').textContent.includes('8/9'), 'bank info renders the assigned-role count (push left empty on purpose)');
  // DEDUPE: the same event key never fires its sticker twice (the old double-sticker bug)
  tgCalls.length = 0;
  await E(`tgSticker('vip','main','shot-1')`);
  await E(`tgSticker('vip','main','shot-1')`);
  await sleep(900);
  assert.equal(tgCalls.filter(c => relayCall(c,'sendSticker')).length, 1, 'same once-key fires exactly ONE sticker');
  // WIN verdict → 1 message + 1 sticker; LOSS → message + the assigned LOSS sticker; PUSH → message + push sticker
  const sig77 = { id: 77, pair: 'EUR/USD', tf: 'M1', time: '12:05', dir: 'CALL', grade: 'A', score: 85 };
  tgCalls.length = 0;
  await E(`botSettleVerify(${JSON.stringify(sig77)},'win',{o:1.1,c:1.15})`);
  await sleep(900);
  assert.equal(tgCalls.filter(c => relayCall(c,'sendSticker')).length, 1, 'WIN sends exactly one sticker');
  assert.ok(tgCalls.some(c => relayCall(c,'sendSticker') && (c.body.includes('F_W1') || c.body.includes('F_W2'))));
  tgCalls.length = 0;
  await E(`botSettleVerify(${JSON.stringify(sig77)},'loss',{o:1.1,c:1.05})`);
  await sleep(900);
  assert.equal(tgCalls.filter(c => relayCall(c,'sendSticker')).length, 1, 'LOSS fires the assigned LOSS sticker (operator choice)');
  assert.ok(tgCalls.some(c => relayCall(c,'sendSticker') && c.body.includes('F_LOSS')));
  const lossMsg = tgCalls.find(c => relayCall(c,'sendMessage') && textOf(c.body).includes('LOSS'));
  assert.ok(lossMsg, 'loss verdict message sent');
  tgCalls.length = 0;
  await E(`botSettleVerify(${JSON.stringify(sig77)},'push',{o:1.1,c:1.1})`);
  await sleep(900);
  assert.ok(tgCalls.some(c => relayCall(c,'sendMessage') && textOf(c.body).includes('PUSH')), 'push verdict sent');
  // clear the loss/push roles → losses and pushes then send NO sticker at all
  E(`stClear('loss'); stClear('push')`);
  assert.equal(E('tg.stk.loss'), ''); assert.equal(E('tg.stk.push'), '');
  tgCalls.length = 0;
  await E(`botSettleVerify(${JSON.stringify(sig77)},'loss',{o:1.1,c:1.05})`);
  await sleep(900);
  assert.equal(tgCalls.filter(c => relayCall(c,'sendSticker')).length, 0, 'unassigned loss role sends no sticker');
  // outros fire once each
  tgCalls.length = 0;
  await E(`tgSticker('outro1','main','k1'); tgSticker('outro2','main','k1')`);
  await sleep(1200);
  const outros = tgCalls.filter(c => relayCall(c,'sendSticker'));
  assert.equal(outros.length, 2, 'completion fires the two outro stickers');
  assert.ok(outros[0].body.includes('F_O1') && outros[1].body.includes('F_O2'));
  // bank caps + clearing
  E(`stPending.length=0; for(let i=0;i<30;i++) stPending.push({file_id:'BULK'+i,label:'bulk'});
     for(let i=0;i<30;i++) assignSticker(stPending.length-1,'win');`);
  assert.ok(E('tg.stk.win.filter(Boolean).length') <= 24, 'win bank capped at 24');
  E(`stClear('win')`);
  assert.equal(E('tg.stk.win.length'), 0);
  E(`stPending.length=0; renderStickers(); renderStPending();`);

  /* ── 15. FORMAT ENGINE: /setformat layouts saved permanently ──── */
  // defaults are ULTRA MINIMAL: pair · dir · time · expiry — nothing else
  const defSignal = E("renderFmt('signal',{pair:'EURUSD',dir:'CALL',time:'10:31',grade:'A',score:88})");
  assert.ok(defSignal.includes('EURUSD') && defSignal.includes('CALL') && defSignal.includes('10:31'), 'default signal = pair+dir+time');
  assert.ok(defSignal.includes('1 min'), 'default signal shows the 1-min expiry');
  assert.ok(!/advice|paper|research|martingale|MTG/i.test(defSignal), 'no extra info in the default signal');
  // unknown placeholders are stripped; *bold* / `code` / _italic_ markup works
  assert.equal(E(`renderFmt('verdict',{result:'✅ WIN',pair:'EURUSD',time:'10:31'})`), '✅ WIN · EURUSD 10:31', 'verdict default is minimal');
  assert.ok(E(`renderFmt('signal',{pair:'EURUSD',dir:'CALL',time:'10:31',grade:'A',bogus:'x'})`).includes('EURUSD'), 'unknown placeholders vanish silently');
  assert.equal(E(`fmtMarkup('a *b* c')`), 'a <b>b</b> c', 'asterisk bold');
  assert.equal(E("fmtMarkup('a `c` d')"), 'a <code>c</code> d', 'backtick code');
  assert.equal(E(`fmtMarkup('<img x>')`), '&lt;img x&gt;', 'markup engine HTML-escapes everything first');
  // /setformat signal <layout> → saved permanently, survives a reload
  assert.equal(E(`fmtSet('signal','🔥 {pair} {dir} @ {time} ({grade})')`), true);
  assert.ok(E("renderFmt('signal',{pair:'EURUSD',dir:'PUT',time:'11:00',grade:'A+'})").includes('🔥 EURUSD PUT @ 11:00 (A+)'), 'custom layout renders live values');
  assert.ok(w.localStorage.getItem('nx_tg').includes('🔥 {pair} {dir}'), 'custom format persisted to browser storage');
  assert.equal(E(`fmtSet('bogus','x')`), false, 'unknown format kind rejected');
  // rows + list + result formats
  E(`px.rows=[{pair:'EUR/USD',tf:'M1',time:'14:30',dir:'CALL',targetT:1,conv:81,grade:'A',out:null}]`);
  const listMsg = E('msgList()');
  assert.ok(listMsg.includes('14:30') && listMsg.includes('EURUSD') && listMsg.includes('CALL'), 'list renders rows through the row format');
  assert.ok(!/MTG|martingale/i.test(listMsg), 'no martingale advice in lists');
  const resMsg = E('msgResult()');
  assert.ok(resMsg.includes('RESULT') && /✅ 0/.test(resMsg), 'result renders counts');
  // bot-configured multi-line format via the listener path
  assert.equal(E(`fmtSet('vip','💎 VIP {pair}\\n{dir} — {time}\\nGrade {grade}')`), true);
  assert.ok(E("msgVip({pair:'GBP/JPY',dir:'CALL',time:'09:15',grade:'A',score:90})").includes('💎 VIP GBPJPY'), 'VIP format carries the vip layout');
  assert.equal(E(`fmtReset('signal')`), true);
  assert.equal(E(`fmtReset('all')`), true);
  assert.ok(!w.localStorage.getItem('nx_tg').includes('🔥 {pair}'), 'reset clears saved layouts');
  // premium emoji: bots cannot send custom emoji — the app never emits tg-emoji entities
  assert.ok(!/tg-emoji|custom_emoji/i.test(html), 'no premium/custom emoji entities anywhere (messages can never fail on them)');
  assert.match($id('fmtList').textContent ? String($id('fmtList').textContent) : 'x', /signal/, 'formats panel lists every kind');
  E(`px.rows=[]`);

  /* ── 16. parallel multi-pair scan + NONSTOP guarantee ─────────── */
  E('cache={}; isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"})');
  E(`$('m5conf').checked=false; $('nonstop').checked=true; $('auto').checked=false; $('blackout').checked=false`);
  const urls = [];
  w.fetch = async (url, opts) => { const req=bodyObject(opts&&opts.body); if(String(url).endsWith('/api/v1/market')) urls.push(req); return jsonResponse({data:candlePayload()}); };
  await E('runScan(true)');
  const tsCalls = urls.filter(req => req.operation==='time_series');
  const symbols = new Set(tsCalls.map(req => req.params.symbol));
  assert.equal(tsCalls.length, 3, 'one candle request per ticked pair');
  assert.equal(symbols.size, 3, 'every ticked pair fetched: ' + [...symbols].join(','));
  assert.ok(urls.every(req => req.operation==='time_series'), 'every scan request is a candle operation: '+JSON.stringify(urls));
  assert.ok(!urls.some(req => ['quote','price','exchange_rate'].includes(req.operation)), 'no diagnostic feeds during normal scans');
  assert.equal(E('credits'), 3);
  assert.ok(!$id('status').textContent.includes('Error:'), 'scan finished without error');
  assert.ok($id('f_q').textContent.includes('not checked'), 'diagnostic cells untouched by scans');
  assert.match($id('pxinfo').textContent, /fresh|stale|weekend/, 'candle freshness is surfaced');
  const m1rows = $id('liveRowsM1').querySelectorAll('.sig-row').length;
  assert.ok(m1rows >= 1, 'NONSTOP produced at least one M1 signal (' + m1rows + ')');
  assert.ok(!/No trades|No signal/i.test($id('status').textContent), 'status never says "No trades"/"No signal"');
  assert.ok(!/no trades/i.test(E('JSON.stringify(notes.map(n=>n.text))')), 'notification centre never logs "no trades"');
  assert.equal(E('openSigs.length>0 && openSigs.every(s=>Number.isFinite(s.targetT)&&s.targetT%60000===0)'), true, 'all targets minute-aligned');
  assert.equal(E('openSigs.every(s=>s.targetT>Date.now())'), true, 'targets point at the NEXT candle');
  assert.ok($id('pairGrid').querySelectorAll('.pcard').length >= 3, 'live pair grid renders every ticked pair');
  // M5 on → one extra candle request per pair, still candle-only
  E(`$('m5conf').checked=true; cache={}; budget.min=[]`); // simulate the next minute, preserving the 7/min hard cap
  const u2 = [];
  w.fetch = async (url, opts) => { const req=bodyObject(opts&&opts.body); if(String(url).endsWith('/api/v1/market')) u2.push(req); return jsonResponse({data:candlePayload()}); };
  await E('runScan(true)');
  assert.equal(u2.filter(req => req.operation==='time_series'&&req.params.interval==='5min').length, 3, 'M5 confirmation per pair, candle feed only');
  assert.ok(u2.every(req => req.operation==='time_series'));
  E(`$('m5conf').checked=false`);

  /* ── 17. settlement loop: confirmed verdicts land in stats/history/paper */
  const pend = JSON.parse(E(`JSON.stringify(openSigs.map(s=>({id:s.id,pair:s.pair,tf:s.tf,targetT:s.targetT,dir:s.dir,stake:s.stake})))`));
  assert.ok(pend.length >= 1);
  const bal0 = E('paper.balance'), w0 = E('stat.M1.w+stat.M3.w');
  for (const s of pend) injectWin(s.pair, s.targetT, s.dir, E);
  await E('settleAll()');
  assert.equal(E('openSigs.length'), 0, 'every open signal settled from confirmed candles');
  assert.ok(E('stat.M1.w+stat.M3.w') > w0, 'wins counted');
  assert.ok(E('paper.balance') > bal0, 'paper balance credited on wins');
  assert.ok($id('hist').textContent.includes('WIN'), 'history shows the verdict');
  assert.ok(JSON.parse(w.localStorage.getItem('nx_hist')).length >= 1, 'history persisted (auditable)');
  const h0 = JSON.parse(w.localStorage.getItem('nx_hist'))[0];
  assert.ok(h0.o != null && h0.c != null, 'verdict stores the settled candle open→close');
  // PUSH path: tie refunds the stake, never counted as loss
  const pushBefore = { bal: E('paper.balance'), losses: E('stat.M1.l+stat.M3.l'), pushes: E('stat.M1.p+stat.M3.p') };
  E(`uid=uid+1; openSigs.push({id:uid,pair:'EUR/USD',tf:'M1',time:'12:00',dir:'CALL',votes:{},conf:0.8,score:80,grade:'A',targetT:${now0 + 10 * M},agents:{},stake:20,payout:0.8,ttOpen:30,regime:'',botSent:false}); saveOpen()`);
  E(`cache['EUR/USD']={t:${now0 + 12 * M},latencyMs:5,m1:[
      {t:'a',ts:${now0 + 10 * M},o:1.1,h:1.2,l:1.0,c:1.1},
      {t:'b',ts:${now0 + 11 * M},o:1.1,h:1.2,l:1.0,c:1.12}],m3:[]}`);
  await E('settleAll()');
  assert.equal(E('stat.M1.p+stat.M3.p'), pushBefore.pushes + 1, 'push counted separately');
  assert.equal(E('stat.M1.l+stat.M3.l'), pushBefore.losses, 'a TIE is never counted as a loss');
  assert.ok(Math.abs(E('paper.balance') - pushBefore.bal) < 0.01, 'push refunds the stake');

  /* ── 18. feed-clock repair: meta fallback + data-clock inference ── */
  assert.equal(E('readFeedTz({meta:{"4. Time Zone":"UTC"}})'), 0, 'plain UTC meta → no correction');
  assert.equal(E('readFeedTz({meta:{"4. Time Zone":"UTC+11"}})'), 660, 'UTC+11 meta detected');
  assert.equal(E('readFeedTz({meta:{"5. Time Zone":"UTC-04:30"}})'), -270, 'UTC-04:30 meta detected');
  assert.equal(E('readFeedTz({meta:{timezone:-4.5}})'), -270, 'numeric meta hours detected');
  assert.equal(E('readFeedTz({values:[]})'), 0, 'missing meta → no correction');
  const baseClock = Date.parse('2026-10-14T12:00:00Z');
  const clockJson = mins => ({ values: [{ datetime: new Date(baseClock + mins * M).toISOString().slice(0, 19).replace('T', ' ') }] });
  assert.equal(E(`inferFeedTz(${JSON.stringify(clockJson(345))},${baseClock})`), 345, 'UTC+05:45 data clock snaps to the 15-minute zone grid');
  assert.equal(E(`inferFeedTz(${JSON.stringify(clockJson(525))},${baseClock})`), 525, 'UTC+08:45 data clock is supported');
  const wrongMeta = { ...clockJson(660), meta: { '4. Time Zone': 'UTC' } };
  assert.equal(E(`resolveFeedTz(${JSON.stringify(wrongMeta)},${baseClock})`), 660, 'clear local data clock wins over contradictory UTC meta');
  assert.equal(E(`resolveFeedTz(${JSON.stringify({ ...clockJson(20), meta: { '4. Time Zone': 'UTC+11' } })},${baseClock})`), 0, 'sub-30-minute lead stays clock drift instead of using meta');
  assert.equal(E('resolveFeedTz({values:[],meta:{"4. Time Zone":"UTC+05:30"}})'), 330, 'meta remains the fallback without a clear data-clock signal');
  assert.match(E('apiTimeSeries.toString()'), /resolveFeedTz/, 'M1 path resolves the effective feed clock');
  assert.match(E('apiM5Bias.toString()'), /resolveFeedTz/, 'M5 path resolves the effective feed clock');
  assert.match(E('deepBacktest.toString()'), /resolveFeedTz/, 'backtest path resolves the effective feed clock');
  E('budget.min=[]; feedTzOff=660');
  assert.equal(E('parseCandleUTC("2024-05-01 03:15:00").toISOString()'), '2024-04-30T16:15:00.000Z', 'naive local stamp shifted back to UTC');
  assert.equal(E('parseCandleUTC("2024-05-01 03:15:00Z").toISOString()'), '2024-05-01T03:15:00.000Z', 'explicit Z stamps untouched');
  assert.equal(E('parseCandleUTC("2024-05-01 03:15:00+02:00").toISOString()'), '2024-05-01T01:15:00.000Z', 'offset-stamped candles untouched');
  E('feedTzOff=0; cache={}');
  w.fetch = async (url, opts) => {
    const p = candlePayload();
    for (const v of p.values) v.datetime = new Date(Date.parse(v.datetime.replace(' ', 'T') + 'Z') + 660 * M).toISOString().slice(0, 19).replace('T', ' ');
    p.meta = { '1. Information': 'candles', '2. Symbol': 'EUR/USD', '4. Time Zone': 'UTC' };
    return jsonResponse({data:p});
  };
  await E('runScan(true)');
  assert.equal(E('feedTzOff'), 660, 'scan infers UTC+11 despite UTC meta');
  assert.equal($id('feedTzNote').style.display, '', 'footer banner shown while the correction is active');
  assert.match($id('feedTzNote').textContent, /feed clock UTC\+11:00 auto-corrected to UTC/);
  const tzNewest = E('cache["EUR/USD"].m1[cache["EUR/USD"].m1.length-1]');
  assert.equal(tzNewest.ts, Date.parse(tzNewest.t.replace(' ', 'T') + 'Z') - 660 * M, 'cached candle ts is the local stamp minus the inferred offset');
  assert.equal(E('candleGate(cache["EUR/USD"].m1).ok'), true, 'corrected newest candle passes the freshness gate');
  const shownUtc = new Date(tzNewest.ts).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  assert.ok($id('pxinfo').textContent.includes(shownUtc), 'info line shows the corrected UTC candle stamp');
  E('cache={}; feedTzOff=0; budget.min=[]');
  w.fetch = async () => { const p = candlePayload(); p.meta = { '4. Time Zone': 'UTC' }; return jsonResponse({data:p}); };
  await E('runScan(true)');
  assert.equal(E('feedTzOff'), 0, 'UTC feed → no shift');
  assert.equal($id('feedTzNote').style.display, 'none', 'banner hidden when the feed is already UTC');

  /* ── 19. optional diagnostics still check all four feeds ─────── */
  E('cache={}');
  const durls = [];
  w.fetch = async (url, opts) => {
    const req=bodyObject(opts&&opts.body); durls.push(req.operation);
    const data=req.operation==='time_series'?candlePayload():req.operation==='quote'
      ?{close:'1.10000',percent_change:'0.05',is_market_open:true}:req.operation==='price'
        ?{price:'1.10000'}:{exchange_rate:'1.10000'};
    return jsonResponse({data});
  };
  await E('verifyFeeds()');
  for (const ep of ['time_series', 'quote', 'price', 'exchange_rate'])
    assert.ok(durls.includes(ep), `diagnostics still verify ${ep} on demand`);
  assert.match($id('status').textContent, /Diagnostics: all 4 feeds live/);

  /* ── 20. manual news blackout blocks new signals ──────────────── */
  $id('blackout').checked = true;
  $id('blackout').dispatchEvent(new w.Event('change'));
  assert.equal(E('blackoutOn()'), true);
  assert.equal(w.localStorage.getItem('nx_blackout'), '1', 'blackout persists in browser storage');
  E('cache={}; budget.min=[]; isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"})');
  const sigCount0 = E('openSigs.length');
  w.fetch = async (url, opts) => jsonResponse({data:candlePayload()});
  await E('runScan(true)');
  assert.equal(E('openSigs.length'), sigCount0, 'blackout blocks even NONSTOP signals');
  assert.match($id('status').textContent, /blackout/i, 'scan reports the blackout');
  assert.match($id('validChips').textContent, /news blackout/i, 'validation shows the blackout chip');
  $id('blackout').checked = false;
  $id('blackout').dispatchEvent(new w.Event('change'));
  assert.equal(E('blackoutOn()'), false);

  /* ── 21. credit budget throttling ─────────────────────────────── */
  E('budget.day=(new Date()).toISOString().slice(0,10); budget.min=[]; budget.calls=perDayCap()*0.65');
  assert.equal(E('budgetLevel()'), 1); assert.equal(E('budgetScanStep()'), 2, 'scan cadence halves at 60% budget');
  E('budget.calls=Math.ceil(perDayCap()*0.8); budget.min=[]');
  assert.equal(E('budgetLevel()'), 2); assert.equal(E('budgetScanStep()'), 0, 'new scans stop at the 80% settlement reserve');
  assert.equal(E('budgetCheck("scan").reason'), 'settlement-reserve');
  assert.equal(E('budgetCheck("settlement").ok'), true, 'pending settlements may spend the reserved 20%');
  assert.equal(E('budgetReserve("scan")'), false, 'hard soft-cap guard rejects a new scan');
  assert.equal(E('budgetReserve("settlement")'), true, 'settlement can reserve a call below the hard cap');
  E('budget.calls=perDayCap(); budget.min=[]');
  assert.equal(E('budgetLevel()'), 3); assert.equal(E('budgetScanStep()'), 0, 'auto scans stop at the cap');
  assert.equal(E('budgetCheck("settlement").reason'), 'daily-cap', 'hard cap blocks settlements too');
  assert.equal(E('budgetReserve("settlement")'), false, 'no paid calls cross the daily hard cap');
  const blockedFetches = [];
  w.fetch = async url => { blockedFetches.push(String(url)); return jsonResponse({ values: [] }); };
  E('cache={}; budget.calls=perDayCap(); budget.min=[]');
  await assert.rejects(E('apiTimeSeries("EUR/USD",{maxAge:0})'), /NEXUS API budget/, 'request is blocked before provider fetch');
  assert.equal(blockedFetches.length, 0, 'hard cap prevents any paid Twelve Data request');
  E('creditLimits.minute=7; budget.calls=0; budget.min=[]; $("m5conf").checked=true');
  assert.equal(E('budgetCheck("ticker").ok'), true, 'one background ticker request may use spare minute headroom');
  assert.equal(E('budgetReserve("ticker")'), true);
  assert.equal(E('budgetCheck("ticker").reason'), 'scan-reserve', 'ticker leaves room for a three-pair M1+M5 scan');
  assert.equal(E('budgetCheck("scan").ok'), true, 'reserved scan capacity stays available');
  E('creditLimits.minute=2; budget.calls=0; budget.min=[Date.now(),Date.now()];');
  assert.equal(E('budgetCheck("scan").reason'), 'minute-cap', 'per-minute hard cap is enforced');
  E('creditLimits=Object.assign({},DEFAULT_CREDIT_LIMITS); budget.calls=0;budget.min=[];$("m5conf").checked=false;renderBudget(true)');
  assert.match($id('budgetInfo').textContent, /per min/, 'budget meter renders');

  /* Channel e2e tests exercise delivery after an already-validated deployment. */
  E('window.__realProductionGate=productionGate; productionGate=()=>({ok:true,reasons:[],n:100,wins:80,wr:.8,lower:.7,breakEven:.56,deepN:50,deepWR:.65})');

  /* ── 22. PREMIUM LIST engine end-to-end (LIST channel) ────────── */
  // pure scheduler: every slot is minute-aligned and 40–60 min after list production
  const producedAt = Math.floor(Date.now() / M) * M + 30000;
  const slots = E(`premiumSlots(${producedAt},5)`);
  assert.equal(slots.length, 5);
  assert.ok(slots[0] - producedAt >= 40 * M, 'first trade has at least 40 minutes notice');
  assert.ok(slots[slots.length - 1] - producedAt <= 60 * M, 'last trade remains within the one-hour horizon');
  assert.ok(slots.every(t => t % M === 0), 'slots minute-aligned');
  assert.equal(new Set(slots).size, slots.length, 'future slots are unique');
  // full flow with an authorized bot + LIST channel
  const pcalls = [];
  w.fetch = async (url, opts) => {
    const u=String(url), body=String((opts&&opts.body)||''), req=bodyObject(body);
    if(u.endsWith('/api/v1/telegram')){
      pcalls.push({url:u,body,method:req.method,channel:req.channel});
      return jsonResponse({ok:true,result:{message_id:50,date:Date.now(),chat:{id:req.channel||'main'}}});
    }
    if(u.endsWith('/api/v1/market')) return jsonResponse({data:candlePayload(360,0.00006)});
    return jsonResponse({});
  };
  enableRelay(E); E('tg.auth=true;tg.auto=true; risk.premiumMin=66');   // synthetic-trend conviction sits in the 70s
  E('tg.stk.list="L_STK"; tg.stk.result="R_STK"; tg.stk.outro1="O1_STK"; tg.stk.outro2="O2_STK"');
  E('isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"})');
  E('cache={}; px=Object.assign({},DEF_PX)');
  await E('premStart(true)');
  await sleep(500);
  assert.equal(pcalls.filter(c => relayCall(c,'sendSticker')).length, 0, 'study phase posts nothing (list sticker fires when the LIST posts)');
  assert.equal(E('px.status'), 'study', '10-minute study phase running');
  E('px.studyEnd=Date.now()-1000');   // fast-forward the study
  await E('premSchedule()');
  const rr = JSON.parse(E('JSON.stringify(px.rows.map(r=>({pair:r.pair,time:r.time,targetT:r.targetT,dir:r.dir,conv:r.conv,grade:r.grade})))'));
  assert.ok(rr.length >= 3, 'study scheduled multiple sure-shot rows (' + rr.length + ')');
  assert.equal(E('px.status'), 'sent');
  for (const r of rr) {
    assert.equal(r.targetT % M === 0, true, 'rows minute-aligned');
    assert.ok(r.targetT - E('px.producedAt') >= 40 * M, 'row is at least 40 min ahead');
    assert.ok(r.targetT - E('px.producedAt') <= 60 * M, 'row is no more than 60 min ahead');
  }
  assert.equal(new Set(rr.map(r => r.pair)).size, rr.length, 'a pair is never repeated in one list');
  await sleep(900);
  const listCall = pcalls.find(c => relayCall(c,'sendMessage') && textOf(c.body).includes('LIST'));
  assert.ok(listCall, 'list auto-sent');
  assert.equal(bodyObject(listCall.body).channel,'list','list goes to the server-configured LIST alias');
  const lb = textOf(listCall.body);
  assert.ok(/[A-Z]{6} • \d{2}:\d{2};(CALL|PUT)/.test(lb), 'row format renders pair • time;dir');
  assert.ok(pcalls.some(c => relayCall(c,'sendSticker') && c.body.includes('L_STK')), 'assigned LIST sticker fired exactly once');
  // verify every row from confirmed candles → single RESULT + result/outro stickers
  const byPair = {};
  for (const r of rr) (byPair[r.pair] = byPair[r.pair] || []).push(r);
  for (const [pair, list] of Object.entries(byPair)) {
    const minT = Math.min(...list.map(r => r.targetT));
    const maxT = Math.max(...list.map(r => r.targetT));
    const m1 = [];
    for (let ts = minT - 5 * M; ts <= maxT + M; ts += M) {
      const row = list.find(r => r.targetT === ts);
      m1.push(row ? { t: 'x', ts, o: 1.1, h: 1.2, l: 1.0, c: row.dir === 'CALL' ? 1.15 : 1.05 }
                  : { t: 'x', ts, o: 1.1, h: 1.15, l: 1.05, c: 1.1 });
    }
    const m3 = [{ t: 'x', ts: minT, o: 1.1, h: 1.2, l: 1.0, c: 1.15 }, { t: 'x', ts: maxT + 180000, o: 1.1, h: 1.2, l: 1.0, c: 1.1 }];
    E(`cache[${JSON.stringify(pair)}]={t:${maxT + 400000},latencyMs:5,m1:${JSON.stringify(m1)},m3:${JSON.stringify(m3)}}`);
  }
  pcalls.length = 0;
  E('premTick()');
  await sleep(2200);
  assert.equal(E('px.status'), 'result', 'engine reached the result phase');
  assert.equal(E('px.rows.every(r=>r.out==="win")'), true, 'all rows verified from confirmed candle closes');
  const resCall = pcalls.find(c => relayCall(c,'sendMessage') && textOf(c.body).includes('RESULT'));
  assert.ok(resCall, 'single RESULT message sent after all outcomes');
  assert.equal(bodyObject(resCall.body).channel,'list','result goes to the server-configured LIST alias');
  const rb = textOf(resCall.body);
  assert.ok(rb.includes('✅') && /✅ \d+ · ❌ \d+ · ➖ \d+/.test(rb), 'result carries ticks and counts');
  const stkAfter = pcalls.filter(c => relayCall(c,'sendSticker')).map(c => c.body);
  assert.equal(stkAfter.filter(b => b.includes('R_STK')).length, 1, 'RESULT sticker fired');
  assert.equal(stkAfter.filter(b => b.includes('O1_STK')).length, 1, 'outro 1 fired');
  assert.equal(stkAfter.filter(b => b.includes('O2_STK')).length, 1, 'outro 2 fired');
  assert.ok($id('predRows').textContent.includes('✅'), 'UI rows show verified ticks');
  // manual control cannot accidentally resend an already-delivered list
  pcalls.length = 0;
  await E('tgSendList()'); await sleep(100);
  assert.equal(pcalls.filter(c => textOf(c.body).includes('LIST')).length, 0, 'duplicate LIST delivery is blocked');
  E('risk.premiumMin=78; premStop(); tg.auto=false; tg.stk={session:"",win:[],loss:"",push:"",vip:"",list:"",result:"",outro1:"",outro2:""}');
  assert.equal(E('px.status'), 'idle');

  /* ── 23. bot stream: gated by authorization ───────────────────── */
  E('tg.botAuto=true; tg.auth=false');
  const bc0 = pcalls.length;
  E(`botDispatch({id:501,pair:'EUR/USD',tf:'M1',time:'12:00',dir:'CALL',grade:'A',score:88})`);
  assert.ok($id('botRows').querySelector('.sig-row'), 'bot stream shows the signal row');
  await sleep(300);
  assert.equal(pcalls.length, bc0, 'no bot send while unauthorized');
  E('tg.auth=true');
  E(`botDispatch({id:502,pair:'EUR/USD',tf:'M1',time:'12:01',dir:'PUT',grade:'A',score:88})`);
  await sleep(900);
  assert.ok(pcalls.length > bc0, 'authorized bot signal sent');
  E('tg.botAuto=false');

  /* ── 23b. PUBLIC stream: strict quality, before the candle opens ─ */
  {
    const p2 = boot();
    const calls2 = [];
    p2.w.fetch = async (url, opts) => {
      const u=String(url), body=String((opts&&opts.body)||''), req=bodyObject(body);
      if(u.endsWith('/api/v1/telegram')){calls2.push({url:u,body,method:req.method,channel:req.channel});return jsonResponse({ok:true,result:{message_id:1,chat:{id:req.channel}}});}
      if(u.endsWith('/api/v1/market')) return jsonResponse({data:candlePayload(360,0.00006)});
      return jsonResponse({});
    };
    enableRelay(p2.E);
    p2.E('isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"}); productionGate=()=>({ok:true,reasons:[]})');
    p2.E(`tg.auth=true;tg.pubStream=true;tg.botAuto=false`);
    p2.E(`cache={}`);
    await p2.E('pubFire(1)');
    await sleep(1500);
    const pubSent = calls2.filter(c => relayCall(c,'sendMessage'));
    if (pubSent.length) {                       // a quality signal existed → it must be in PUBLIC, minimal format
      assert.ok(pubSent.every(c => bodyObject(c.body).channel==='public'), 'public signal uses only the server-configured PUBLIC alias');
      const t = textOf(pubSent[0].body);
      assert.ok(/[A-Z]{6}/.test(t) && /(CALL|PUT)/.test(t), 'public signal carries pair + direction');
      assert.ok(!/advice|paper|research/i.test(t), 'public signal is ultra-minimal — no extra info');
      assert.equal(JSON.parse(p2.E('JSON.stringify(pubStat)')).sent, 1, 'public stream counts the send');
      // signal targets the NEXT candle and was sent before it opened
      const sig = JSON.parse(p2.E('JSON.stringify(openSigs[openSigs.length-1])'));
      assert.ok(sig.pub === true && sig.targetT % M === 0, 'public signal is tagged for the public verdict path');
    } else {
      assert.equal(JSON.parse(p2.E('JSON.stringify(pubStat)')).skipped >= 1, true, 'no quality signal this minute → skipped (never a low-grade filler)');
    }
    assert.deepEqual(p2.errors, [], 'public engine clean');
    p2.w.close();
  }

  /* ── 23c. VIP stream: best available shot every 10 min, honest grade ─ */
  {
    const p3 = boot();
    const calls3 = [];
    p3.w.fetch = async (url, opts) => {
      const u=String(url), body=String((opts&&opts.body)||''), req=bodyObject(body);
      if(u.endsWith('/api/v1/telegram')){calls3.push({url:u,body,method:req.method,channel:req.channel});return jsonResponse({ok:true,result:{message_id:1,chat:{id:req.channel}}});}
      if(u.endsWith('/api/v1/market')) return jsonResponse({data:candlePayload(360,0.00006)});
      return jsonResponse({});
    };
    enableRelay(p3.E);
    p3.E('isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"}); productionGate=()=>({ok:true,reasons:[]})');
    p3.E(`tg.auth=true;tg.vipStream=true;tg.stk.vip='V_STK'`);
    p3.E(`cache={}; vx.lastSlot=0; vx.shots=[]`);
    await p3.E('vxFire(true)');
    await sleep(1800);
    const vipMsg = calls3.find(c => relayCall(c,'sendMessage') && bodyObject(c.body).channel==='vip');
    if (vipMsg) {
      const vt = textOf(vipMsg.body);
      assert.ok(/[A-Z]{6}/.test(vt) && /(CALL|PUT)/.test(vt), 'VIP shot carries pair + direction');
      assert.ok(/Grade/.test(vt), 'VIP shot shows the honest grade');
      assert.ok(calls3.some(c => relayCall(c,'sendSticker') && c.body.includes('V_STK')), 'assigned VIP sticker fired');
      assert.equal(JSON.parse(p3.E('JSON.stringify(vx.shots)')).length, 1, 'shot recorded with its verdict pending');
    } else {
      assert.match(p3.E('vx.notes[0]'), /quality|gate|skipped/i, 'VIP safely skips when no setup clears every quality gate');
      assert.equal(JSON.parse(p3.E('JSON.stringify(vx.shots)')).length, 0, 'a weak VIP filler is never recorded');
    }
    assert.ok($id === null || true);
    assert.deepEqual(p3.errors, [], 'VIP engine clean');
    p3.w.close();
  }

  /* ── 24. public channel: privacy filter enforced ──────────────── */
  assert.match(E(`sanitizePublic("bot 123456789:AAFdeadbeefdeadbeefdeadbeefdeadbeef ok")`), /redacted-token/, 'token redacted');
  assert.match(E(`sanitizePublic("mail me a@b.example.com please")`), /redacted-email/, 'email redacted');
  assert.match(E(`sanitizePublic("chat -1001234567890 here")`), /redacted-id/, 'numeric id redacted');
  assert.match(E(`sanitizePublic("key 0123456789abcdef0123456789abcdef leak")`), /redacted-key/, '32-hex key redacted');
  enableRelay(E); E('tg.auth=true');
  const bodies = [];
  w.fetch = async (url, opts) => {
    const u=String(url), body=String((opts&&opts.body)||''), req=bodyObject(body);
    if(u.endsWith('/api/v1/telegram')){bodies.push(body);return jsonResponse({ok:true,result:{message_id:1,chat:{id:req.channel}}});}
    return jsonResponse({});
  };
  assert.equal(await E(`pubPost("leak 123456789:AAFdeadbeefdeadbeefdeadbeefdeadbeef now")`), true);
  assert.ok(bodies.length && bodies[bodies.length-1].includes('redacted-token'), 'posted text is redacted before it leaves the browser');
  assert.ok(!bodies[bodies.length-1].includes('AAFdeadbeef'), 'raw token never leaves the browser');
  const bc2=bodies.length;
  assert.equal(await E(`pubPost("123456789:AAFdeadbeefdeadbeefdeadbeefdeadbeef")`),false,'sensitive-only post refused');
  assert.equal(bodies.length,bc2,'refused post sent nothing');

  /* ── 25. local-art pipeline: public site can never load it ───── */
  assert.equal(E(`localArtHost('zenosx77.github.io')`), false, 'GitHub Pages host never loads local art');
  assert.equal(E(`localArtHost('localhost')`), true, 'localhost may load local art');
  assert.equal(E(`localArtHost('8080-sbx.e2b.app')`), true, 'preview host may load local art');
  assert.equal(fs.existsSync('assets/art'), false, 'no copyrighted art inside the repo');
  assert.equal(fs.existsSync('art'), false, 'no art/ directory inside the repo');
  assert.match(fs.readFileSync('.gitignore', 'utf8'), /^art\//m, '.gitignore blocks art/');
  const wfSrc = fs.readFileSync('.github/workflows/deploy-pages.yml', 'utf8');
  assert.ok(!/cp\s+.*\bart\b/.test(wfSrc), 'deploy workflow never copies art');
  assert.ok(!/art\/[A-Za-z0-9_-]+\.(jpg|png|webp)/.test(html), 'no static art references in the public HTML');

  /* ── 26. M1, M3 and premium list stay separate ────────────────── */
  assert.ok($id('liveRowsM1') !== $id('liveRowsM3') && $id('liveRowsM3') !== $id('predRows'), 'three distinct streams');
  E(`addRow('EUR/USD','12:00','CALL',901,'A','M1',80)`);
  E(`addRow('EUR/USD','12:03','PUT',902,'A','M3',81)`);
  assert.ok($id('mk-901') && $id('liveRowsM1').contains($id('mk-901')), 'M1 row lands in the M1 stream');
  assert.ok($id('mk-902') && $id('liveRowsM3').contains($id('mk-902')), 'M3 row lands in the M3 stream');
  assert.ok(!$id('liveRowsM1').contains($id('mk-902')), 'streams do not mix');

  /* ── 27. signal-only / paper mode preserved ───────────────────── */
  assert.equal(E('typeof paperResolve'), 'function');
  assert.equal(E('paper.halted'), false);
  assert.match(html, /signal-only \+ paper-trading mode|paper-trade only|signal-only by design/i, 'disclaimer still states paper mode');
  assert.ok(!/placeOrder|brokerConnect|executeLive/i.test(inline[0]), 'no live-execution hooks introduced');
  assert.match(html, /TELEGRAM PRODUCTION: LOCKED/, 'production panel starts locked behind paper validation');

  E('productionGate=window.__realProductionGate');

  /* ── 28. deep training math + readiness honesty ───────────────── */
  const deepRes = E(`(function(){
    const n=600,o=[],h=[],l=[],c=[],ts=[];
    const base=Math.floor(Date.now()/60000)*60000;
    for(let i=0;i<n;i++){ const p=1.1+0.001*Math.sin(i/7)+0.0004*i/n*10;
      o[i]=p; c[i]=p+0.0001*Math.sin(i/1.7+0.7); h[i]=Math.max(o[i],c[i])+0.00005; l[i]=Math.min(o[i],c[i])-0.00005; ts[i]=base-(n-i)*60000; }
    const series=ts.map((t,i)=>({t:'x',ts:t,o:o[i],h:h[i],l:l[i],c:c[i]}));
    const d=deepTrainSeries(series,'M1');
    return {keys:Object.keys(d.strats).length,bars:d.bars,sample:d.strats['EMA 9/21 cross'],ens:d.ensVn};
  })()`);
  assert.equal(deepRes.keys, 26, 'deep training covers all 26 strategies');
  assert.equal(deepRes.bars, 600);
  assert.ok(deepRes.sample && typeof deepRes.sample.wr === 'number' && typeof deepRes.sample.vwr === 'number');
  E('renderReady()');
  assert.match($id('readyVerdict').textContent, /PRODUCTION (LOCKED|UNLOCKED)/, 'production validation verdict is explicit');
  assert.match($id('readyVerdict').textContent, /confirmed/i, 'readiness counts confirmed settlements only');
  assert.ok(!/guaranteed (wins?|profits?|\d\d%)/i.test(html), 'no guaranteed-win marketing language anywhere');
  assert.ok(!/\b9\d% guaranteed\b/i.test(html), 'no guaranteed win-rate claims');
  assert.match(html, /never guarantees/i, 'the app states plainly that it never guarantees profits');

  /* ── 29. legacy migration on a seeded boot ───────────────────── */
  const b2 = boot({
    td_key: 'legacy-key-123',
    nx_watch: JSON.stringify(['GBP/USD', 'BTC/USD', 'USD/JPY']),
    nx_tg: JSON.stringify({ token: 'x', chatId: '1', sticker: 'LEGACY_STICKER', auth: false,
      stickers: { intro: 'OLD_INTRO', win: ['OLD_W1'], outro: ['OLD_O1', 'OLD_O2'] } }),
    nx_batch: JSON.stringify({ date: 'old', status: 'active', startedAt: Date.now(), target: 5, rows: [{ pair: 'EUR/USD', tf: 'M1', time: '12:00', dir: 'CALL', targetT: Date.now() + 60000, win: true, grade: 'A' }] }),
    nx_stats2: JSON.stringify({ M1: { w: 3, l: 1 }, M3: { w: 0, l: 0 } }),
    nx_page: 'prem',
  });
  assert.deepEqual(b2.errors, [], 'legacy boot is clean');
  assert.deepEqual(b2.E('JSON.stringify(tg.stk.win)'), '["OLD_W1"]', 'v5 win bank migrated forward');
  const b2b = boot({ nx_tg: JSON.stringify({ token: 'x', chatId: '1', sticker: 'LEGACY_STICKER', auth: false }) });
  assert.equal(b2b.E('tg.stk.win[0]'), 'LEGACY_STICKER', 'legacy single sticker migrates into the WIN bank when it was empty');
  b2b.w.close();
  assert.equal(b2.E('typeof tg.sticker'), 'undefined', 'legacy sticker field retired');
  assert.equal(b2.E('typeof tg.stickers'), 'undefined', 'v5 sticker schema retired');
  assert.equal(b2.E('tg.stk.session'), 'OLD_INTRO', 'v5 intro sticker migrated to the SESSION START role');
  assert.equal(b2.E('tg.stk.outro1'), 'OLD_O1', 'v5 outro[0] migrated to outro1');
  assert.equal(b2.E('tg.stk.outro2'), 'OLD_O2', 'v5 outro[1] migrated to outro2');
  assert.equal(b2.E('typeof tg.styleMode'), 'undefined', 'v5 style capture retired (format engine replaces it)');
  assert.equal(b2.E('px.rows.length'), 1, 'v4 batch rows migrated into the premium engine');
  assert.equal(b2.E('px.rows[0].out'), 'win', 'legacy win flags mapped to outcomes');
  assert.equal(b2.E('stat.M1.p'), 0, 'push counter backfilled on legacy stats');
  assert.deepEqual(JSON.parse(b2.w.localStorage.getItem('nx_watch')), ['GBP/USD', 'USD/JPY'], 'watchlist keeps valid pairs, drops unknown ones');
  assert.equal(b2.E('keyPool().length'),0,'legacy provider credential is not restored into browser memory');
  assert.equal(b2.w.localStorage.getItem('td_key'),'','legacy provider store key retired');
  assert.equal(b2.w.localStorage.getItem('nx_keys10'),'','legacy slot vault retired');
  assert.equal(b2.doc.getElementById('key1'),null,'provider-key input is removed');
  const safeLegacyTg=JSON.parse(b2.w.localStorage.getItem('nx_tg'));
  assert.equal(safeLegacyTg.token,undefined,'legacy Telegram token is scrubbed from storage');
  assert.equal(safeLegacyTg.chatId,undefined,'legacy Telegram destination is scrubbed from storage');
  assert.equal(b2.doc.getElementById('page-prem').classList.contains('on'), true, 'last visited page restored');
  b2.w.close();

  /* ── 30. SESSION scenario A: target 1 win → complete + 2 outros ─ */
  {
    const s = boot();
    const scalls = [];
    s.w.fetch = async (url, opts) => {
      const u=String(url), body=String((opts&&opts.body)||''), req=bodyObject(body);
      if(u.endsWith('/api/v1/telegram')){scalls.push({url:u,body,method:req.method,channel:req.channel});return jsonResponse({ok:true,result:{message_id:1,chat:{id:req.channel||'main'}}});}
      if(u.endsWith('/api/v1/market')) return jsonResponse({data:candlePayload()});
      return jsonResponse({});
    };
    enableRelay(s.E);
    s.E('isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"}); productionGate=()=>({ok:true,reasons:[]})');
    s.E(`tg.auth=true;tg.auto=true`);
    s.E(`tg.stk={session:'S_INTRO',win:['S_W1','S_W2'],loss:'',push:'',vip:'',list:'',result:'',outro1:'S_O1',outro2:'S_O2'}`);
    s.E(`$('m5conf').checked=false; $('nonstop').checked=true; $('sessTarget').value=1`);
    await s.E('sxStart()');
    await sleep(2500);
    assert.ok(scalls.some(c => relayCall(c,'sendSticker') && c.body.includes('S_INTRO')), 'session opens with the SESSION START sticker (visibility fix)');
    const sigCall = scalls.find(c => relayCall(c,'sendMessage') && textOf(c.body).includes('CALL'));
    assert.ok(sigCall || scalls.some(c => textOf(c.body).includes('PUT')), 'session signal sent straight to MAIN in the configured format');
    assert.equal(s.E('sx.status'), 'waiting', 'signal claimed and waiting for verification');
    const cur = JSON.parse(s.E('JSON.stringify(sx.current)'));
    assert.ok(cur && cur.targetT % M === 0);
    assert.ok(s.E('sx.huntStart') > 0);
    injectWin(cur.pair, cur.targetT, cur.dir, s.E);
    scalls.length = 0;
    await s.E('settleAll()');
    await sleep(2600);
    assert.equal(s.E('sx.wins'), 1, 'win counted');
    assert.equal(s.E('sx.status'), 'done', 'target reached → session complete');
    const st = scalls.filter(c => relayCall(c,'sendSticker'));
    assert.ok(st.some(c => c.body.includes('S_W1') || c.body.includes('S_W2')), 'WIN fired a random sticker from the bank');
    assert.ok(st.some(c => c.body.includes('S_O1')) && st.some(c => c.body.includes('S_O2')), 'completion fired BOTH outro stickers');
    assert.ok(scalls.some(c => relayCall(c,'sendMessage') && textOf(c.body).includes('SESSION COMPLETE')), 'completion summary sent');
    assert.deepEqual(s.errors, [], 'scenario A clean');
    s.w.close();
  }

  /* ── 31. SESSION scenario B: loss → OTM 💔, no sticker, quality guard */
  {
    const s = boot();
    const scalls = [];
    s.w.fetch = async (url, opts) => {
      const u=String(url), body=String((opts&&opts.body)||''), req=bodyObject(body);
      if(u.endsWith('/api/v1/telegram')){scalls.push({url:u,body,method:req.method,channel:req.channel});return jsonResponse({ok:true,result:{message_id:1,chat:{id:req.channel||'main'}}});}
      if(u.endsWith('/api/v1/market')) return jsonResponse({data:candlePayload()});
      return jsonResponse({});
    };
    enableRelay(s.E);
    s.E('isWeekendWindow=()=>false; sessionGate=()=>({ok:true,reason:"test"}); productionGate=()=>({ok:true,reasons:[]})');
    s.E(`tg.auth=true;tg.auto=true`);
    s.E(`tg.stk={session:'S_INTRO',win:['S_W1'],loss:'',push:'',vip:'',list:'',result:'',outro1:'S_O1',outro2:'S_O2'}`);
    s.E(`$('m5conf').checked=false; $('nonstop').checked=true; $('sessGuard').value=1`);
    await s.E('sxStart()');
    await sleep(2500);
    assert.equal(s.E('sx.status'), 'waiting');
    const cur = JSON.parse(s.E('JSON.stringify(sx.current)'));
    injectWin(cur.pair, cur.targetT, cur.dir === 'CALL' ? 'PUT' : 'CALL', s.E);  // candle moves AGAINST the signal
    scalls.length = 0;
    await s.E('settleAll()');
    await sleep(1600);
    assert.equal(s.E('sx.losses'), 1);
    assert.equal(s.E('sx.status'), 'idle', 'quality guard stopped the session after the guarded loss');
    assert.equal(scalls.filter(c => relayCall(c,'sendSticker')).length, 0, 'LOSS with no assigned loss sticker fires NO sticker');
    const lm = scalls.find(c => relayCall(c,'sendMessage') && textOf(c.body).includes('LOSS'));
    assert.ok(lm, 'loss verdict sent');
    assert.ok(scalls.some(c => relayCall(c,'sendMessage') && textOf(c.body).includes('QUALITY GUARD')), 'guard abort announced');
    // push verdict keeps the session alive and uncounted
    s.E(`sx.status='waiting'; sx.current={id:9001,pair:'EUR/USD',tf:'M1',time:'12:00',dir:'CALL',targetT:5,grade:'A',score:80}; sx.guard=3`);
    s.E(`sxOnSettled({id:9001,pair:'EUR/USD',tf:'M1',time:'12:00',dir:'CALL'},'push',{o:1.1,c:1.1})`);
    assert.equal(s.E('sx.pushes'), 1);
    assert.equal(s.E('sx.losses'), 1, 'push is not a loss');
    assert.equal(s.E('sx.status'), 'hunting', 'session keeps hunting after a push');
    assert.deepEqual(s.errors, [], 'scenario B clean');
    s.w.close();
  }

  /* ── 32. CLOUD SYNC (Supabase mirror): degradation + config + payload contracts ── */
  {
    // (a) source-level guarantees
    assert.match(html,/connect-src[^;]*https:/,'CSP permits the configured HTTPS relay and Supabase project');
    assert.ok(!/https?:\/\/(?:api\.twelvedata\.com|api\.telegram\.org)/i.test(html),'browser source has no direct provider or Bot API host');
    assert.ok(!/SUPABASE_SERVICE_ROLE|service_role_key|"role"\s*:\s*"service_role"|sbServiceKey/.test(html),
      'no service-role key handling anywhere in the page (anon-only mirror)');
    assert.ok($id('page-cloud'), 'cloud page exists');
    E('sbClear()');
    assert.equal(E('sbReady()'), false, 'cloud sync offline by default');
    assert.equal(await E('sbTrackPrediction({pair:"EUR/USD",tf:"M1",dir:"CALL",targetT:Date.now()+60000,conf:.7,grade:"A",votes:{},agents:{},origin:"live"})'),
      false, 'prediction mirror is a silent no-op without config');
    E('sbRecordDelivery("pub","signal","sent",null,"text","@chan")');   // compatibility shim must never throw or write private logs from the browser
    E('showPage("cloud")');
    assert.ok($id('sbChip').textContent.includes('OFFLINE'), 'chip shows OFFLINE');
    assert.ok($id('sbApplyBtn').disabled, 'apply button disabled without a verified model');
    E('sbCfg={url:"https://nexus-test.supabase.co",anon:"",record:true}; sbChipRender()');
    assert.ok($id('sbChip').textContent.includes('CONFIGURATION REQUIRED'), 'partial configuration is never reported as connected');
    E('sbClear()');
    assert.ok(!html.includes('can never double-send'), 'delivery copy makes no exactly-once claim');
    E('showPage("dash")');

    // (b) configured mirror — captured fetch, contract of every write
    const sbCalls = [];
    const sb = boot({ nx_sb: JSON.stringify({ url: 'https://nexus-test.supabase.co', anon: 'A'.repeat(40), record: true }) },
      w => {
        try { w.crypto.subtle = require('node:crypto').webcrypto.subtle; }
        catch (e) { try { Object.defineProperty(w.crypto, 'subtle', { value: require('node:crypto').webcrypto.subtle }); } catch (e2) { /* jsdom variant */ } }
        w.fetch = async (url, opts) => {
          sbCalls.push({ url: String(url), opts });
          const u = String(url);
          if (u.includes('/rest/v1/predictions')) return jsonResponse([{ id: 'uuid-1' }]);
          if (u.includes('/rest/v1/telegram_deliveries')) throw new Error('Browser must never access raw delivery logs');
          if (u.includes('model_versions')) return jsonResponse([]);
          if (u.includes('risk_snapshots')) return jsonResponse([]);
          if (u.includes('v_market_freshness')) return jsonResponse([]);
          if (u.includes('v_deliveries_public')) return jsonResponse([]);
          if (u.includes('currency_pairs')) return jsonResponse([{ code: 'EUR/USD' }]);
          return jsonResponse([]);
        };
      });
    assert.deepEqual(sb.errors, [], 'cloud-configured boot is clean');
    assert.equal(sb.E('sbReady()'), true, 'config accepted');
    assert.equal(sb.E('sbRecording()'), true, 'recording enabled');
    assert.ok(sb.w.document.getElementById('sbChip').textContent.includes('NOT VERIFIED'), 'configured but unverified is not SYNC ON');
    await sb.E('sbTest()');
    await sleep(80);
    assert.ok(sb.w.document.getElementById('sbChip').textContent.includes('DATABASE OK'), 'database access alone does not claim relay authentication');
    assert.ok(!sb.w.document.getElementById('sbChip').textContent.includes('SYNC ON'), 'no SYNC ON without relay session');
    assert.ok(sb.w.document.getElementById('sbFresh').textContent.includes('NO WORKER RUNS'), 'no worker run recorded is shown as such, not as healthy');
    assert.ok(sb.w.document.getElementById('sbDeliv') !== null, 'delivery log panel present');
    await sb.E('sbTrackPrediction({pair:"EUR/USD",tf:"M3",dir:"PUT",targetT:1730000000000,conf:.62,grade:"B",votes:{ema:"PUT",rsi:"CALL"},agents:{TREND:-1},origin:"live"})');
    await sleep(50);
    const pred = sbCalls.find(c => c.url.includes('/rest/v1/predictions'));
    assert.ok(pred, 'prediction POST captured');
    assert.ok(pred.url.startsWith('https://nexus-test.supabase.co/rest/v1/'), 'raw REST client — no SDK/CDN');
    assert.equal(pred.opts.method, 'POST');
    assert.ok(String(pred.opts.headers.prefer).includes('resolution=ignore-duplicates'), 'idempotent inserts');
    assert.equal(pred.opts.headers.apikey, 'A'.repeat(40), 'anon key header');
    const pbody = JSON.parse(pred.opts.body);
    assert.equal(pbody.pair_code, 'EUR/USD');
    assert.equal(pbody.timeframe, '3m');
    assert.equal(pbody.evaluation_horizon, 3, 'M3 horizon = 3 one-minute candles');
    assert.equal(pbody.direction, 'PUT');
    assert.equal(pbody.source, 'browser');
    assert.equal(pbody.is_shadow, false, 'browser can never write shadow rows');
    assert.equal(pbody.strategy_version, 'nexus-fusion-v1');
    assert.deepEqual(pbody.strategy_detail.votes, { ema: 'PUT', rsi: 'CALL' }, 'per-strategy votes recorded for the trainer');
    assert.equal(pbody.confidence, 62, 'confidence stored 0-100');
    const beforeDelivery=sbCalls.length;
    sb.E('sbRecordDelivery("pub","signal","sent",null,"msg text","@channel")');
    await sleep(50);
    assert.equal(sbCalls.length,beforeDelivery,'browser never inserts delivery payloads or chat IDs directly');
    assert.ok(!sbCalls.some(c=>c.url.includes('/rest/v1/telegram_deliveries')),'delivery audit/retry rows are relay-managed');

    // (c) canonical JSON + SHA-256 model verification (cross-checked with the Python trainer fixture)
    const FIXTURE = {
      kind: 'strategy-weights', model_id: 'nexus-weights-test',
      timeframes: {
        '1m': { strats: { ema: { vwr: 0.55, vtrades: 120 }, rsi: { vwr: 0.5, vtrades: 60 } } },
        '3m': { strats: { ema: { vwr: 1.0, vtrades: 40 } } },
      },
      metrics: { holdout: { win_rate: 0.6, n: 50, expectancy_bps: 1.25, profit_factor: null, max_drawdown_bps: 12.5 } },
      note: 'café ✓',
    };
    const FIXTURE_SHA = '43925bb7706d2e548f1a280bd123848a31189ff57a41f67654e2f5c0c1fdc3ec';   // pinned from trainer/test_trainer.py
    const canon = sb.E(`sbCanonical(${JSON.stringify(FIXTURE)})`);
    const nodeSha = require('node:crypto').createHash('sha256').update(canon).digest('hex');
    assert.equal(nodeSha, FIXTURE_SHA, 'JS canonicalization matches the Python trainer byte-for-byte');
    // apply the VERIFIED model → weights merge into the brain, logic untouched
    sb.E('deep = {M1:null,M3:null}');
    sb.E(`sbDeployed = ${JSON.stringify({ id: 'nexus-weights-test', artifact_sha256: FIXTURE_SHA, artifact_payload: FIXTURE, metrics: {} })}`);
    await sb.E('sbApplyModel()');
    assert.equal(sb.E('deep.M1.strats.ema.vwr'), 0.55, 'cloud vwr merged into deep brain');
    assert.equal(sb.E('deep.M1.strats.ema.vtrades'), 120, 'cloud vtrades merged');
    assert.equal(sb.E('deep.M3.strats.ema.vwr'), 1, '3m timeframe mapped to M3');
    assert.ok(sb.doc.getElementById('sbApplyMsg').textContent.includes('applied'), 'apply confirmation shown (never silent)');
    // checksum mismatch → rejected, nothing merged
    sb.E('deep = {M1:null,M3:null}');
    sb.E(`sbDeployed = ${JSON.stringify({ id: 'tampered', artifact_sha256: 'deadbeef'.repeat(8), artifact_payload: FIXTURE, metrics: {} })}`);
    await sb.E('sbApplyModel()');
    assert.equal(sb.E('deep.M1'), null, 'checksum mismatch → artifact rejected, brain untouched');
    assert.ok(sb.doc.getElementById('sbApplyMsg').textContent.includes('checksum mismatch'), 'mismatch reason surfaced');
    // Correct checksum is not sufficient: reject the whole malformed model before merging.
    const invalid = JSON.parse(JSON.stringify(FIXTURE));
    invalid.timeframes['3m'].strats.ema.vwr = 2;
    const invalidSha = require('node:crypto').createHash('sha256')
      .update(sb.E(`sbCanonical(${JSON.stringify(invalid)})`)).digest('hex');
    sb.E(`sbDeployed = ${JSON.stringify({id:'invalid',artifact_sha256:invalidSha,artifact_payload:invalid})}`);
    await sb.E('sbApplyModel()');
    assert.equal(sb.E('deep.M1'), null, 'invalid later timeframe must not partially apply valid first timeframe');
    assert.ok(sb.doc.getElementById('sbApplyMsg').textContent.includes('invalid strategy weight'));

    sb.w.close();
  }

  /* ── 33. chaos pass: every UI entry point runs without throwing ── */
  E('tg.auth=false; tg.listen=false; sxStop("chaos"); premStop()');
  w.fetch = async (url, opts) => {
    const u=String(url),req=bodyObject(opts&&opts.body);
    if(u.endsWith('/api/v1/telegram')) return jsonResponse({ok:true,result:{message_id:1,chat:{id:req.channel||'main'}}});
    if(u.endsWith('/api/v1/market')){
      const data=req.operation==='time_series'?candlePayload():req.operation==='quote'
        ?{close:'1.1',percent_change:'0.01',is_market_open:true}:req.operation==='price'
          ?{price:'1.1'}:{exchange_rate:'1.1'};
      return jsonResponse({data});
    }
    if(u.endsWith('/api/v1/health')) return jsonResponse({ok:true,provider:{configured:true,keyCount:2},browserBudget:{dailyLimit:700,perMinuteLimit:7}});
    if(u.endsWith('/api/v1/usage')) return jsonResponse({keys:[{key:'server key 1',used:1,limit:700}]});
    if(u.endsWith('/api/v1/session')) return jsonResponse({ok:true,userId:'00000000-0000-4000-8000-000000000001',telegramAdmin:true,telegramConfigured:true,telegramChannels:{main:true,public:true,vip:true,list:true,admin:true}});
    if(u.includes('/auth/v1/')) return jsonResponse({access_token:'test-session-token',refresh_token:'test-refresh-token',expires_in:3600});
    return jsonResponse({});
  };
  const entryPoints = [
    'saveKeys()', 'verifyFeeds()', 'runScan(true)', 'premStart(false)', 'premStop()', 'sxStart()', 'sxStop("test")',
    'tgSendList()', 'tgSendResult()', 'tgTest()', 'tgSetCommands()', 'pullStickers()',
    'fmtSet("signal","{pair} {dir}")', 'fmtReset("signal")', 'fmtReset("all")', 'fmtPreview("signal")', 'fmtPreview("vip")', 'fmtPreview("list")',
    'assignSticker(99,"win")', 'stClear("win")', 'stTest("win")', 'stTest("vip")', 'pubPost()',
    'apiUsageCheck()', 'renderUsage()', 'renderVip()', 'renderPubInfo()', 'renderKeyInputs()', 'pubTick()', 'vxTick()', 'settleVip()',
    'resetPaper()', 'resetStreak()', 'clearStats()', 'deepBacktest()', 'trainDeep()', 'exportCSV()',
    'renderPerf()', 'renderPred()', 'renderVault()', 'tgRender()', 'renderSess()', 'renderReady()', 'renderDeepInfo()',
    'setBrainTf("M3")', 'setBrainTf("M1")', 'renderStats()', 'renderPaper()', 'syncSettings()', 'ensureDay()',
    'settleAll()', 'settlePrem()', 'settlementFetches()', 'livePairsRender()', 'renderTopLive()', 'renderNotes()',
    'clearNotes()', 'showPage("brain")', 'showPage("dash")', 'showPage("vip")', 'showPage("cloud")', 'sxTick()', 'premTick()', 'premStudySample(0)', 'sxForce()',
    'sbSave()', 'sbClear()', 'sbTest()', 'sbLoadModel()', 'sbLoadPerf()', 'sbLoadFresh()', 'sbLoadDeliv()', 'sbInit()',
  ];
  for (const ep of entryPoints) {
    await assert.doesNotReject(E(`(async()=>{ ${ep}; })()`), `UI entry point ${ep} must not throw`);
  }
  await sleep(500);   // let stray fire-and-forget promises settle against the mocks
  assert.deepEqual(errors, [], 'no DOM/runtime errors during the chaos pass');

  assert.deepEqual(errors, [], 'no DOM/runtime errors across the whole suite');
  console.log('PASS: boot · DOM refs · 11 tabbed pages · font+license · Meridian branding · 10 live pairs ·');
  console.log('      server-only provider credentials + relay credit caps · stale+weekend gates · quality gates ·');
  console.log('      stable confirmed settlement (feed-keyed · revision-safe · ties=push) · 4-channel routing ·');
  console.log('      sticker bank (9 event roles · dedupe · nothing unassigned ever fires) · format engine (/setformat) ·');
  console.log('      parallel scans · PUBLIC stream (quality-only, before the open) · VIP stream (best shot/10 min) ·');
  console.log('      news blackout · credit budget throttle · LIST e2e (live study→40–60m unique slots→result+stickers) ·');
  console.log('      bot stream · public privacy filter · local-art lockdown · M1/M3/list separation ·');
  console.log('      CLOUD SYNC (anon-only mirror · idempotent writes · relay-managed delivery records · SHA-256 model apply ·');
  console.log('      offline degradation · canonical JSON matches the Python trainer) ·');
  console.log('      paper mode · deep training + readiness honesty · legacy migration · SESSION scenarios · chaos pass');
  w.close();
}
main().catch(e => { console.error(e); process.exitCode = 1; try { w.close(); } catch (_) {} });
