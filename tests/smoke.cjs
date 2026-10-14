// Run: npm install --no-save --no-package-lock jsdom@26 && node tests/smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync('index(1).html', 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
assert.equal(inline.length, 1, 'one inline application script');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM(html, {
  url: 'https://example.test/', runScripts: 'outside-only', virtualConsole: vc,
  beforeParse(w) {
    w.setInterval = () => 1;
    w.confirm = () => true;
  }
});
const { window: w } = dom;
const context = dom.getInternalVMContext();
vm.runInContext(inline[0], context);
assert.deepEqual(errors, [], 'application boots without DOM/runtime errors');
const E = expr => vm.runInContext(expr, context);
async function main() {
  assert.equal(E('tgReady()'), false);
  assert.equal(E('tgMatchesChat({id:123})'), false);
  assert.equal(E('tzLabel()').startsWith('UTC'), true);
  assert.equal(E('candleOutcome("EUR/USD","M1","CALL",60000)'), null);
  assert.equal(E('keyPool().length'), 0, 'no real keys in public build');
  assert.equal(E('batch.status'), 'idle');
  assert.ok(w.document.getElementById('liveRowsM1'));
  assert.ok(w.document.getElementById('liveRowsM3'));
  assert.ok(w.document.getElementById('predRows'));
  let calls = 0;
  w.fetch = async () => { calls++; return {json: async () => ({ok:true,result:true})}; };
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"123",text:"hi"})'), /no bot token/);
  assert.equal(calls, 0, 'no unauthenticated network send');
  E('tg.token="test-token";tg.chatId="123"');
  await assert.rejects(E('tgCall("sendMessage",{chat_id:"123",text:"hi"})'), /not authorized/);
  assert.equal(calls, 0);
  E('tg.auth=true');
  assert.equal(E('tgMatchesChat({id:123})'), true);
  assert.equal(E('tgMatchesChat({id:999})'), false);
  await E('tgCall("sendMessage",{chat_id:"123",text:"hi"})');
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: boot, streams, keys, settlement, authorization, chat isolation, Telegram transport');
  w.close();
}
main().catch(e => {console.error(e);process.exitCode=1;w.close();});
