// NEXUS Glass v4.2.4 — smoke + regression suite (jsdom).
// Run: npm install && npm test        (run it twice — the suite is idempotent)
// Covers: clean boot, EUR/USD-only watchlist (no rotation), 4 key slots with
// one-click browser save + rotation + quota cooldown, candle-only scans
// (quote/price/exchange_rate are optional diagnostics), stale/weekend candle
// rejection, feed-clock timezone repair (naive local stamps → UTC), manual
// news blackout, Telegram save + authorization revocation,
// M1/M3/list separation, paper/signal-only guards, font + license assets,
// and full HTML/DOM reference integrity.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const FILE = 'index.html';
const html = fs.readFileSync(FILE, 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
assert.equal(inline.length, 1, 'exactly one inline application script');

function boot(seedStorage) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://example.test/', runScripts: 'outside-only', virtualConsole: vc,
    beforeParse(w) {
      w.setInterval = () => 1;           // never fire timers during tests
      w.confirm = () => true;
      if (seedStorage) for (const [k, v] of Object.entries(seedStorage)) w.localStorage.setItem(k, v);
    },
  });
  const context = dom.getInternalVMContext();
  vm.runInContext(inline[0], context);
  const E = expr => vm.runInContext(expr, context);
  return { dom, w: dom.window, E, errors, doc: dom.window.document };
}

/* deterministic fresh EUR/USD candle payload, Twelve Data shape (newest first) */
function candlePayload(n = 360) {
  const startMin = Math.floor(Date.now() / 60000) * 60000;
  const values = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(startMin - i * 60000);
    const dt = t.toISOString().slice(0, 19).replace('T', ' ');
    const p = 1.1 + 0.0009 * Math.sin(i / 9) + 0.0003 * Math.sin(i / 2.7) + 0.0002 * Math.sin(i / 23);
    const o = +p.toFixed(5), c = +(p + 0.00012 * Math.sin(i / 1.3)).toFixed(5);
    const h = +(Math.max(o, c) + 0.00006).toFixed(5), l = +(Math.min(o, c) - 0.00006).toFixed(5);
    values.push({ datetime: dt, open: String(o), high: String(h), low: String(l), close: String(c) });
  }
  return { values };
}
function jsonResponse(obj) { return { status: 200, json: async () => obj }; }

const { w, E, errors, doc, dom } = boot();
const $id = id => doc.getElementById(id);

async function main() {
  /* ── 1. clean boot ───────────────────────────────────────────── */
  assert.deepEqual(errors, [], 'application boots without DOM/runtime errors');

  /* ── 2. HTML/DOM reference integrity ─────────────────────────── */
  // every literal $('id') in the inline script must exist in the booted DOM
  const jsIds = new Set([...inline[0].matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  const missing = [...jsIds].filter(id => !$id(id));
  assert.deepEqual(missing, [], 'all JS-referenced element ids exist in the DOM');
  // every onclick="fn(...)" must reference a defined function
  const fns = new Set([...html.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]));
  for (const fn of fns) assert.equal(E(`typeof ${fn}`), 'function', `onclick handler ${fn}() is defined`);
  // every in-page anchor (section nav etc.) must have a target
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    const h = a.getAttribute('href');
    if (h === '#') continue;                       // in-card action links
    assert.ok($id(h.slice(1)), `anchor target ${h} exists`);
  }
  // section navigation covers the main cards
  assert.ok($id('secNav'), 'section nav present');
  assert.ok(doc.querySelectorAll('#secNav a').length >= 12, 'section nav has clear links');
  for (const s of ['sec-keys', 'sec-feeds', 'sec-scan', 'sec-m1', 'sec-m3', 'sec-list', 'sec-tg', 'sec-paper', 'sec-bt'])
    assert.ok($id(s), `section id ${s} exists`);
  // no duplicate element ids anywhere (breaks $() lookups silently)
  const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dupIds = allIds.filter((v, i) => allIds.indexOf(v) !== i);
  assert.deepEqual([...new Set(dupIds)], [], 'no duplicate element ids');

  /* ── 3. self-hosted font + license shipped with the site ─────── */
  assert.ok(html.includes("url('assets/fonts/inter-latin-wght-normal.woff2')"), '@font-face points at the self-hosted file');
  assert.ok(fs.existsSync('assets/fonts/inter-latin-wght-normal.woff2'), 'font file exists in repo');
  const lic = fs.readFileSync('assets/fonts/INTER-OFL-LICENSE.txt', 'utf8');
  assert.ok(lic.includes('SIL OPEN FONT LICENSE Version 1.1'), 'OFL 1.1 license included');
  assert.ok(lic.includes('Inter Project Authors'), 'license names the Inter authors');
  assert.ok(html.includes("font-src 'self'"), 'CSP allows self-hosted fonts only');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), 'no external font CDN references');

  /* ── 4. EUR/USD only, no pair rotation ───────────────────────── */
  assert.equal(E('JSON.stringify(PAIRS)'), '["EUR/USD"]', 'EUR/USD is the only pair');
  assert.equal($id('btPair').options.length, 1, 'backtest pair list has EUR/USD only');
  assert.equal($id('btPair').options[0].value, 'EUR/USD');
  assert.equal(doc.querySelectorAll('#watch input').length, 1, 'watchlist has a single pair');
  assert.equal(doc.querySelector('#watch input').checked, true, 'EUR/USD ticked by default');
  assert.ok(!/rrIdx/.test(inline[0]), 'pair-rotation index removed from the code');
  const scanSrc = E('runScan.toString()');
  assert.ok(!/rrIdx|rotation/.test(scanSrc), 'runScan contains no rotation logic');
  assert.ok(!/apiQuote|apiPrice|apiRate/.test(scanSrc), 'runScan never calls the diagnostic feeds');
  assert.ok(/apiTimeSeries/.test(scanSrc), 'runScan uses the candle feed');

  /* ── 5. legacy boot state + core primitives ──────────────────── */
  assert.equal(E('tgReady()'), false);
  assert.equal(E('tgMatchesChat({id:123})'), false);
  assert.equal(E('tzLabel()').startsWith('UTC'), true);
  assert.equal(E('candleOutcome("EUR/USD","M1","CALL",60000)'), null);
  assert.equal(E('keyPool().length'), 0, 'no real keys in the public build');
  assert.equal(E('batch.status'), 'idle');
  assert.ok($id('liveRowsM1') && $id('liveRowsM3') && $id('predRows'));
  assert.match($id('liveRowsM1').textContent, /No live M1 signals yet/, 'M1 empty state');
  assert.match($id('liveRowsM3').textContent, /No live M3 signals yet/, 'M3 empty state');
  assert.equal(E('blackoutOn()'), false, 'news blackout defaults to OFF');

  /* ── 6. four key slots: one-click save → browser storage ─────── */
  for (let i = 1; i <= 4; i++) $id('key' + i).value = 'td-key-' + i;
  assert.equal(E('saveKeys()'), true, 'one-click save succeeds');
  assert.deepEqual(JSON.parse(w.localStorage.getItem('nx_keys4')),
    ['td-key-1', 'td-key-2', 'td-key-3', 'td-key-4'], 'slots persisted to localStorage');
  assert.equal(E('keyPool().length'), 4, 'pool holds all four saved slots');
  assert.equal(E('JSON.stringify(keyPool().map(k=>k.src))'), '["slot1","slot2","slot3","slot4"]');
  // duplicates are rejected, previous slots stay intact
  $id('key2').value = 'td-key-1';
  assert.equal(E('saveKeys()'), false, 'duplicate keys across slots rejected');
  assert.ok($id('vaultMsg').textContent.includes('duplicate'), 'duplicate explained to the user');
  assert.equal(E('keyPool().length'), 4, 'rejected save changed nothing');
  // masked display never leaks full keys
  assert.ok(!$id('vaultInfo').textContent.includes('td-key-1'), 'vault display masks keys');

  /* ── 7. rotation + quota cooldown ────────────────────────────── */
  E('keyIdx=0');
  assert.equal(E('nextKey().v'), 'td-key-1');
  assert.equal(E('nextKey().v'), 'td-key-2', 'rotation advances');
  E('keyIdx=2; markKeyLimited("td-key-3")');
  assert.equal(E('nextKey().v'), 'td-key-4', 'quota-limited key is skipped (cooldown)');
  E('keyIdx=2; keyHealth["td-key-3"].until=Date.now()-1');
  assert.equal(E('nextKey().v'), 'td-key-3', 'key returns after cooldown expires');
  E('keyHealth["td-key-3"].until=0');

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
  const stale = fresh.map(b => ({ ...b, ts: b.ts - 10 * 60000 }));
  const gStale = E('candleGate(' + JSON.stringify(stale) + ')');
  assert.equal(gStale.ok, false); assert.match(gStale.reason, /stale/i, 'stale candles rejected');
  const future = fresh.map(b => ({ ...b, ts: b.ts + 60 * 60000 }));
  assert.match(E('candleGate(' + JSON.stringify(future) + ').reason'), /future/i, 'future timestamps rejected');
  const satFresh = fresh; // same freshness, but evaluated at a Saturday timestamp
  const gWknd = E(`candleGate(${JSON.stringify(satFresh)}, new Date("2026-10-17T12:00:00Z"))`);
  assert.equal(gWknd.ok, false); assert.match(gWknd.reason, /weekend/i, 'weekend candles rejected even if "fresh"');
  // gate failure flows through validation → no pass
  const vdGate = E(`validateSetup({dir:"CALL",conf:0.9,agree:4,conflict:0,channels:[]},{q:0.8},
    {thr:0.7,boost:{}},{doji:false,marketOpen:null,minScore:50,ttOpen:20,dataLagMs:0,score:80,grade:"A",
     gate:{ok:false,reason:"stale candles — test"}})`);
  assert.equal(vdGate.pass, false);
  assert.ok(vdGate.fails.some(f => /stale candles/.test(f)), 'gate reason surfaces in validation fails');

  /* ── 9. Telegram transport authorization (unchanged strictness) ─ */
  let calls = 0, lastUrl = '';
  w.fetch = async (url) => { calls++; lastUrl = String(url); return jsonResponse({ ok: true, result: true }); };
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"123",text:"hi"})'), /no bot token/);
  assert.equal(calls, 0, 'no unauthenticated network send');
  E('tg.token="test-token";tg.chatId="123"');
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"123",text:"hi"})'), /not authorized/);
  assert.equal(calls, 0);
  E('tg.auth=true');
  assert.equal(E('tgMatchesChat({id:123})'), true);
  assert.equal(E('tgMatchesChat({id:999})'), false, 'other chats are isolated');
  await E('tgCall("sendMessage",{chat_id:"123",text:"hi"})');
  assert.equal(calls, 1); assert.ok(lastUrl.includes('api.telegram.org'));

  /* ── 10. Telegram: easy save + revocation on token/chat change ── */
  // one-click save persists token/chat/brand and revokes changed credentials
  E('tg.auth=false');
  $id('tgToken').value = 'tok-1'; $id('tgChat').value = '@chan1'; $id('tgBrand').value = 'BRANDX';
  assert.equal(E('tgSaveSettings()'), true);
  assert.equal(E('tg.token'), 'tok-1'); assert.equal(E('tg.chatId'), '@chan1'); assert.equal(E('tg.brand'), 'BRANDX');
  assert.ok(w.localStorage.getItem('nx_tg').includes('BRANDX'), 'settings persisted to browser storage');
  // authorize, then change the token → authorization must be revoked
  E('tg.auth=true;tgRender()');
  $id('tgToken').value = 'tok-2';
  $id('tgToken').dispatchEvent(new w.Event('change'));
  assert.equal(E('tg.auth'), false, 'token change revokes authorization');
  assert.equal($id('tgAuth').checked, false, 'AUTH toggle flips off');
  assert.match(E('tg.log[0]'), /REVOKED/, 'revocation is logged');
  // re-authorize, then change destination chat → revoked again
  E('tg.auth=true;tgRender()');
  $id('tgChat').value = '999';
  $id('tgChat').dispatchEvent(new w.Event('change'));
  assert.equal(E('tg.auth'), false, 'chat change revokes authorization');
  // invalid chat format is refused and changes nothing
  E('tg.auth=true;tg.chatId="999";tgRender()');
  $id('tgChat').value = '!!bad!!';
  $id('tgChat').dispatchEvent(new w.Event('change'));
  assert.equal(E('tg.auth'), true, 'invalid input cannot strip authorization silently');
  assert.equal(E('tg.chatId'), '999');
  // saving identical settings keeps authorization (no needless revocation)
  $id('tgToken').value = E('tgToken()'); $id('tgChat').value = '999';
  assert.equal(E('tgSaveSettings()'), true);
  assert.equal(E('tg.auth'), true, 'unchanged save keeps authorization');
  // with authorization revoked, nothing leaves the machine
  const before = calls;
  E('tg.auth=false');
  await assert.rejects(E('tgSend("hi")'), /not authorized/i);
  assert.equal(calls, before, 'revoked token/chat → zero sends');

  /* ── 11. normal scans hit ONLY the candle endpoint ────────────── */
  E('cache={}');                                   // force a fresh fetch
  E('isWeekendWindow=()=>false');                  // make the scan test date-independent
  const urls = [];
  w.fetch = async (url) => { urls.push(String(url)); return jsonResponse(candlePayload()); };
  await E('runScan(true)');
  assert.ok(urls.length >= 2, 'scan fetched M1 + M5 candles');
  assert.ok(urls.every(u => u.includes('/time_series')), 'every scan request is a candle request');
  assert.ok(urls.some(u => u.includes('interval=5min')), 'M5 confirmation also uses the candle feed');
  assert.ok(!urls.some(u => /\/(quote|price|exchange_rate)\?/.test(u)), 'no diagnostic feeds during normal scans');
  assert.equal(E('credits'), 2, 'quality scan = 2 candle credits (M1 + M5)');
  assert.ok(!$id('status').textContent.includes('Error:'), 'scan finished without error');
  assert.ok($id('f_q').textContent.includes('not checked'), 'diagnostic cells untouched by scans');
  assert.match($id('pxinfo').textContent, /fresh|stale|weekend/, 'candle freshness is surfaced');
  // M5 off → exactly one candle request
  E(`$('m5conf').checked=false; cache={}`);
  const u2 = [];
  w.fetch = async (url) => { u2.push(String(url)); return jsonResponse(candlePayload()); };
  await E('runScan(true)');
  assert.equal(u2.length, 1, 'M5 off → single candle request per scan');
  assert.equal(E('credits'), 3);
  E(`$('m5conf').checked=true`);

  /* ── 12. optional diagnostics still check all four feeds ─────── */
  E('cache={}');
  const durls = [];
  w.fetch = async (url) => {
    const u = String(url); durls.push(u);
    if (u.includes('/time_series')) return jsonResponse(candlePayload());
    if (u.includes('/quote')) return jsonResponse({ close: '1.10000', percent_change: '0.05', is_market_open: true });
    if (u.includes('/price')) return jsonResponse({ price: '1.10000' });
    return jsonResponse({ exchange_rate: '1.10000' });
  };
  await E('verifyFeeds()');
  for (const ep of ['time_series', 'quote', 'price', 'exchange_rate'])
    assert.ok(durls.some(u => u.includes('/' + ep + '?')), `diagnostics still verify ${ep} on demand`);
  assert.match($id('status').textContent, /Diagnostics: all 4 feeds live/);

  /* ── 13. manual news blackout blocks new signals ──────────────── */
  $id('blackout').checked = true;
  $id('blackout').dispatchEvent(new w.Event('change'));
  assert.equal(E('blackoutOn()'), true);
  assert.equal(w.localStorage.getItem('nx_blackout'), '1', 'blackout persists in browser storage');
  E('cache={}');
  w.fetch = async (url) => { urls.push(String(url)); return jsonResponse(candlePayload()); };
  await E('runScan(true)');
  assert.match($id('status').textContent, /blackout/i, 'scan reports the blackout');
  assert.match($id('validChips').textContent, /news blackout/i, 'validation shows the blackout chip');
  E('renderValidation({pass:true,fails:[],warns:[],ev:0.1},{ok:true,reason:"ok"},false,{dir:"CALL"})');
  assert.match($id('validChips').textContent, /news blackout/, 'chip shown even when all else passes');
  $id('blackout').checked = false;
  $id('blackout').dispatchEvent(new w.Event('change'));
  assert.equal(E('blackoutOn()'), false);
  assert.equal(w.localStorage.getItem('nx_blackout'), '0');

  /* ── 13b. quality-first gates (session, confluence, ATR band, M5) ── */
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

  /* ── 13c. lead time: prediction lands in the PREVIOUS minute ───── */
  assert.equal($id('leadSec').value, '30', 'default lead 30s');
  $id('leadSec').value = '45';
  assert.equal(E('leadSecOf()'), 45);
  assert.equal(E('shouldAutoFire(45,29,28,45,false)'), true, 'fires at 45s left with lead 45');
  assert.equal(E('shouldAutoFire(46,29,28,45,false)'), false, 'not before the lead window');
  assert.equal(E('shouldAutoFire(45,29,29,45,false)'), false, 'one fire per minute');
  assert.equal(E('shouldAutoFire(45,29,28,45,true)'), false, 'never double-scan while busy');
  $id('leadSec').value = '30';

  /* ── 13d. one-hour list window ──────────────────────────────────── */
  assert.ok(E('batchWindowLeft({status:"active",startedAt:Date.now()-60000},Date.now())') > 3500000, 'fresh window ~60 min');
  assert.equal(E('batchWindowLeft({status:"active",startedAt:Date.now()-3610000},Date.now())'), 0, 'window elapsed → 0');
  assert.equal(E('batchWindowLeft({status:"idle",startedAt:0},Date.now())'), null, 'no window when idle');
  E(`batch.status="active"; batch.startedAt=Date.now()-3610000; batch.rows=[];`);
  E(`batchCollect({tf:"M1",pair:"EUR/USD",time:"12:00",dir:"CALL",targetT:Date.now()+60000,score:99,grade:"A+",agree:5,conflict:0,ev:1})`);
  assert.equal(E('batch.rows.length'), 0, 'expired window collects nothing');
  assert.notEqual(E('batch.status'), 'active', 'expired window auto-closes');
  E(`batch.status="idle"; batch.startedAt=0`);

  /* ── 13e. bot stream: signal → verification → sticker, gated ────── */
  E('tg.botAuto=true');
  const bc0 = calls;
  E(`botDispatch({id:501,pair:"EUR/USD",tf:"M1",time:"12:00",dir:"CALL",grade:"A",score:88})`);
  assert.ok($id('botRows').querySelector('.sig-row'), 'bot stream shows the signal row');
  assert.equal(calls, bc0, 'no bot send while unauthorized');
  E('tg.auth=true;tgRender()');
  w.fetch = async () => { calls++; return jsonResponse({ ok: true, result: true }); };
  E(`botDispatch({id:502,pair:"EUR/USD",tf:"M1",time:"12:01",dir:"PUT",grade:"A",score:88})`);
  await new Promise(r => setTimeout(r, 700));
  assert.ok(calls > bc0, 'authorized bot signal sent');
  const bc1 = calls;
  await E(`botSettleVerify({id:502,tf:"M1",pair:"EUR/USD",time:"12:01",dir:"PUT"},true)`);
  assert.ok(calls > bc1, 'verification sent on settle');
  assert.equal($id('botmk-502').textContent, '✅', 'bot row ticks on verification');
  E('tg.botAuto=false');

  /* ── 13f. public channel: privacy filter enforced ───────────────── */
  assert.match(E(`sanitizePublic("bot 123456789:AAFdeadbeefdeadbeefdeadbeefdeadbeef ok")`), /redacted-token/, 'token redacted');
  assert.match(E(`sanitizePublic("mail me a@b.example.com please")`), /redacted-email/, 'email redacted');
  assert.match(E(`sanitizePublic("chat -1001234567890 here")`), /redacted-id/, 'numeric id redacted');
  assert.match(E(`sanitizePublic("key 0123456789abcdef0123456789abcdef leak")`), /redacted-key/, '32-hex key redacted');
  E(`tg.pubChat="@comm"`);
  const bodies = [];
  w.fetch = async (url, opts) => { calls++; bodies.push(String((opts && opts.body) || '')); return jsonResponse({ ok: true, result: true }); };
  assert.equal(await E(`pubPost("leak 123456789:AAFdeadbeefdeadbeefdeadbeefdeadbeef now")`), true);
  assert.ok(bodies.length && bodies[bodies.length - 1].includes('redacted-token'), 'posted text is redacted');
  assert.ok(!bodies[bodies.length - 1].includes('AAFdeadbeef'), 'raw token never leaves the machine');
  const bc2 = calls;
  assert.equal(await E(`pubPost("123456789:AAFdeadbeefdeadbeefdeadbeefdeadbeef")`), false, 'sensitive-only post refused');
  assert.equal(calls, bc2, 'refused post sent nothing');
  E(`tg.pubChat=""`);

  /* ── 13g. captured style templates ──────────────────────────────── */
  assert.equal(E(`entToHtml('ab cd',[{type:'bold',offset:3,length:2}])`), 'ab <b>cd</b>', 'entities → safe HTML');
  const tpl = { text: '📊 PIRATE LIST\nDATE 01-01-2026 · UTC+6:00\nM1;EURUSD•14:30;CALL ⏳\nWin (0) Loss (0)', entities: [{ type: 'bold', offset: 0, length: 6 }] };
  const tplOut = E(`applyTpl(${JSON.stringify(tpl)}, ${JSON.stringify([{ pair: 'EUR/USD', time: '15:30', dir: 'PUT', win: null }])}, ${JSON.stringify({ date: '14-10-2026', tz: 'UTC+5:30', w: 3, l: 1 })})`);
  assert.ok(tplOut.includes('M1;EURUSD•15:30;PUT'), 'template rows carry live values');
  assert.ok(tplOut.includes('14-10-2026') && tplOut.includes('UTC+5:30'), 'template header carries live date/tz');
  assert.ok(tplOut.includes('Win (3)') && tplOut.includes('Loss (1)'), 'template summary carries live counts');
  E(`tg.listTpl=${JSON.stringify(tpl)}; batch.rows=[{pair:"EUR/USD",tf:"M1",time:"15:30",dir:"PUT",targetT:5,win:null,grade:"A"}]`);
  assert.ok(E('msgList()').includes('EURUSD•15:30;PUT'), 'msgList adopts the captured style');
  E('tg.listTpl=null; batch.rows=[]');

  /* ── 13h. local-art pipeline: public site can never load it ───── */
  assert.equal(E(`localArtHost('zenosx77.github.io')`), false, 'GitHub Pages host never loads local art');
  assert.equal(E(`localArtHost('localhost')`), true, 'localhost may load local art');
  assert.equal(E(`localArtHost('127.0.0.1')`), true);
  assert.equal(E(`localArtHost('8080-sbx.e2b.app')`), true, 'preview host may load local art');
  assert.equal(fs.existsSync('assets/art'), false, 'no copyrighted art inside the repo');
  assert.equal(fs.existsSync('art'), false, 'no art/ directory inside the repo');
  assert.match(fs.readFileSync('.gitignore', 'utf8'), /^art\//m, '.gitignore blocks art/');
  const wfSrc = fs.readFileSync('.github/workflows/deploy-pages.yml', 'utf8');
  assert.ok(!/cp\s+.*\bart\b/.test(wfSrc), 'deploy workflow never copies art');
  assert.ok(!/art\/[A-Za-z0-9_-]+\.(jpg|png|webp)/.test(html), 'no static art references in the public HTML');

  /* ── 13i. feed clock repair: meta fallback + data-clock inference ── */
  assert.equal(E('readFeedTz({meta:{"4. Time Zone":"UTC"}})'), 0, 'plain UTC meta → no correction');
  assert.equal(E('readFeedTz({meta:{"4. Time Zone":"UTC+11"}})'), 660, 'UTC+11 meta detected');
  assert.equal(E('readFeedTz({meta:{"5. Time Zone":"UTC-04:30"}})'), -270, 'UTC-04:30 meta detected');
  assert.equal(E('readFeedTz({meta:{timezone:-4.5}})'), -270, 'numeric meta hours detected');
  assert.equal(E('readFeedTz({values:[]})'), 0, 'missing meta → no correction');
  const baseClock = Date.parse('2026-10-14T12:00:00Z');
  const clockJson = mins => ({ values: [{ datetime: new Date(baseClock + mins * 60000).toISOString().slice(0, 19).replace('T', ' ') }] });
  assert.equal(E(`inferFeedTz(${JSON.stringify(clockJson(345))},${baseClock})`), 345, 'UTC+05:45 data clock snaps to the 15-minute zone grid');
  assert.equal(E(`inferFeedTz(${JSON.stringify(clockJson(525))},${baseClock})`), 525, 'UTC+08:45 data clock is supported');
  const wrongMeta = { ...clockJson(660), meta: { '4. Time Zone': 'UTC' } };
  assert.equal(E(`resolveFeedTz(${JSON.stringify(wrongMeta)},${baseClock})`), 660, 'clear local data clock wins over contradictory UTC meta');
  assert.equal(E(`resolveFeedTz(${JSON.stringify({ ...clockJson(20), meta: { '4. Time Zone': 'UTC+11' } })},${baseClock})`), 0, 'sub-30-minute lead stays clock drift instead of using meta');
  assert.equal(E('resolveFeedTz({values:[],meta:{"4. Time Zone":"UTC+05:30"}})'), 330, 'meta remains the fallback without a clear data-clock signal');
  assert.match(E('apiTimeSeries.toString()'), /resolveFeedTz/, 'M1 path resolves the effective feed clock');
  assert.match(E('apiM5Bias.toString()'), /resolveFeedTz/, 'M5 path resolves the effective feed clock');
  assert.match(E('deepBacktest.toString()'), /resolveFeedTz/, 'backtest path resolves the effective feed clock');
  E('feedTzOff=660');
  assert.equal(E('parseCandleUTC("2024-05-01 03:15:00").toISOString()'), '2024-04-30T16:15:00.000Z', 'naive local stamp shifted back to UTC');
  assert.equal(E('parseCandleUTC("2024-05-01 03:15:00Z").toISOString()'), '2024-05-01T03:15:00.000Z', 'explicit Z stamps untouched');
  assert.equal(E('parseCandleUTC("2024-05-01 03:15:00+02:00").toISOString()'), '2024-05-01T01:15:00.000Z', 'offset-stamped candles untouched');
  E('feedTzOff=0; cache={}');
  // Exact regression: meta claims UTC while every naive candle is stamped 11 hours ahead.
  w.fetch = async (url) => {
    const p = candlePayload();
    for (const v of p.values) v.datetime = new Date(Date.parse(v.datetime.replace(' ', 'T') + 'Z') + 660 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    p.meta = { '1. Information': 'candles', '2. Symbol': 'EUR/USD', '4. Time Zone': 'UTC' };
    return jsonResponse(p);
  };
  await E('runScan(true)');
  assert.equal(E('feedTzOff'), 660, 'scan infers UTC+11 despite UTC meta');
  assert.equal($id('feedTzNote').style.display, '', 'footer banner shown while the correction is active');
  assert.match($id('feedTzNote').textContent, /feed clock UTC\+11:00 auto-corrected to UTC/);
  const tzNewest = E('cache["EUR/USD"].m1[cache["EUR/USD"].m1.length-1]');
  assert.equal(tzNewest.ts, Date.parse(tzNewest.t.replace(' ', 'T') + 'Z') - 660 * 60000, 'cached candle ts is the local stamp minus the inferred offset');
  assert.equal(E('candleGate(cache["EUR/USD"].m1).ok'), true, 'corrected newest candle passes the freshness gate');
  const shownUtc = new Date(tzNewest.ts).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  assert.ok($id('pxinfo').textContent.includes(shownUtc), 'info line shows the corrected UTC candle stamp');
  assert.ok(!$id('pxinfo').textContent.includes(tzNewest.t), 'info line does not show the misleading local stamp while correcting');
  assert.ok(!$id('status').textContent.includes('Error:'), 'scan still completes cleanly with the correction on');
  // UTC (or absent) meta → identical behaviour, banner hidden
  E('cache={}; feedTzOff=0');
  w.fetch = async () => {
    const p = candlePayload();
    p.meta = { '4. Time Zone': 'UTC' };
    return jsonResponse(p);
  };
  await E('runScan(true)');
  assert.equal(E('feedTzOff'), 0, 'UTC feed → no shift');
  assert.equal($id('feedTzNote').style.display, 'none', 'banner hidden when the feed is already UTC');
  const utcNewest = E('cache["EUR/USD"].m1[cache["EUR/USD"].m1.length-1]');
  assert.equal(utcNewest.ts, Date.parse(utcNewest.t.replace(' ', 'T') + 'Z'), 'UTC feed timestamps unchanged');

  /* ── 14. M1, M3 and prediction list stay separate ─────────────── */
  assert.ok($id('liveRowsM1') !== $id('liveRowsM3') && $id('liveRowsM3') !== $id('predRows'), 'three distinct streams');
  E(`addRow('EUR/USD','12:00','CALL',901,'A','M1',80)`);
  E(`addRow('EUR/USD','12:03','PUT',902,'A','M3',81)`);
  assert.ok($id('mk-901') && $id('liveRowsM1').contains($id('mk-901')), 'M1 row lands in the M1 stream');
  assert.ok($id('mk-902') && $id('liveRowsM3').contains($id('mk-902')), 'M3 row lands in the M3 stream');
  assert.ok(!$id('liveRowsM1').contains($id('mk-902')), 'streams do not mix');
  assert.equal($id('predRows').querySelectorAll('.pred-row').length, 0, 'list is fed only by batch collection');
  assert.ok(!$id('liveRowsM1').querySelector('.empty-note'), 'empty placeholder cleared on first signal');

  /* ── 15. signal-only / paper mode preserved ───────────────────── */
  assert.equal(E('typeof paperResolve'), 'function');
  assert.equal(E('paper.halted'), false);
  assert.match(html, /signal-only \+ paper-trading mode|paper-trade only/i, 'disclaimer still states paper mode');
  assert.ok(!/placeOrder|brokerConnect|executeLive/i.test(inline[0]), 'no live-execution hooks introduced');

  /* ── 16. legacy single-key migration on a fresh boot ──────────── */
  const b2 = boot({
    td_key: 'legacy-key-123',
    nx_watch: JSON.stringify(['GBP/USD', 'EUR/USD', 'USD/JPY']),
    nx_batch: JSON.stringify({ date: 'old', tz: 'UTC+0:00', status: 'active', rows: [], target: 5 }),
  });
  assert.deepEqual(b2.errors, [], 'legacy boot is clean');
  assert.ok(b2.E('batch.startedAt') > 0, 'pre-v4.2 active batch gets a window start on migration');
  assert.ok(b2.E('batchWindowLeft(batch,Date.now())') !== null, 'migrated batch window is enforced');
  const pool2 = b2.E('keyPool()');
  assert.equal(pool2.length, 1, 'legacy key migrated into the slot pool');
  assert.equal(pool2[0].v, 'legacy-key-123');
  assert.equal(pool2[0].src, 'slot1', 'legacy key lands in slot 1');
  assert.equal(b2.w.localStorage.getItem('td_key'), '', 'legacy store key retired');
  assert.equal(b2.doc.getElementById('key1').value, 'legacy-key-123', 'slot input pre-filled');
  assert.equal(b2.E('JSON.stringify(watch())'), '["EUR/USD"]', 'legacy multi-pair watchlist collapsed to EUR/USD');
  b2.w.close();

  /* ── 17. chaos pass: every UI entry point runs without throwing ── */
  w.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) return jsonResponse({ ok: true, result: true });
    if (u.includes('/time_series')) return jsonResponse(candlePayload());
    if (u.includes('/quote')) return jsonResponse({ close: '1.1', percent_change: '0.01', is_market_open: true });
    if (u.includes('/price')) return jsonResponse({ price: '1.1' });
    return jsonResponse({ exchange_rate: '1.1' });
  };
  const entryPoints = [
    'saveKeys()', 'verifyFeeds()', 'runScan(true)', 'batchStart(false)', 'batchStop()', 'runSession()',
    'tgSendList()', 'tgSendResult()', 'tgTest()', 'tgSetCommands()', 'tgCaptureSticker()',
    'tgCaptureStyle("list")', 'tgCaptureStyle("bogus")', 'tgClearStyle()', 'pubPost()',
    'resetPaper()', 'resetStreak()', 'clearStats()', 'deepBacktest()',
    'renderPerf()', 'renderPred()', 'renderVault()', 'tgRender()', 'setBrainTf("M3")', 'setBrainTf("M1")',
    'renderStats()', 'renderPaper()', 'syncSettings()', 'ensureDay()', 'settleAll()', 'settleBatch()',
  ];
  for (const ep of entryPoints) {
    await assert.doesNotReject(E(`(async()=>{ ${ep}; })()`), `UI entry point ${ep} must not throw`);
  }
  assert.deepEqual(errors, [], 'no DOM/runtime errors during the chaos pass');

  assert.deepEqual(errors, [], 'no DOM/runtime errors across the whole suite');
  console.log('PASS: boot · DOM refs · font+license · EUR/USD-only · 4 key slots (save/rotate/cooldown) ·');
  console.log('      stale+weekend gates · telegram save+revocation · candle-only scans · diagnostics ·');
  console.log('      news blackout · quality gates (session/confluence/ATR/M5) · lead-time auto-fire ·');
  console.log('      1-hour list window · feed-clock UTC repair · bot stream (signal→verify→sticker) ·');
  console.log('      public privacy filter · captured style templates · M1/M3/list separation ·');
  console.log('      paper mode · legacy migration');
  w.close();
}
main().catch(e => { console.error(e); process.exitCode = 1; try { w.close(); } catch (_) {} });
