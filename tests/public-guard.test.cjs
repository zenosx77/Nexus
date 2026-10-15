'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scanner = path.resolve('tools/check-public.cjs');
const jwt = role => Buffer.from('{"alg":"HS256"}').toString('base64url') + '.'
  + Buffer.from(JSON.stringify({ role, test: 'fake-not-a-real-key' })).toString('base64url') + '.fakeSignature';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-public-test-'));
  const pub = path.join(root, 'public');
  fs.mkdirSync(pub);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(pub, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write('index.html', '<html>safe</html>');
  return { root, pub, write, run: () => spawnSync(process.execPath, [scanner, pub], { cwd: root, encoding: 'utf8' }) };
}
test('public URLs and anon/publishable keys are allowed', t => {
  const f = fixture(t);
  f.write('config.js', `const url="https://relay.example.test"; const anon="${jwt('anon')}"; const publishable="sb_publishable_FAKE_TEST_ONLY";`);
  assert.equal(f.run().status, 0);
});
test('every asset is scanned for secret formats, private assignments and provider bypasses', async t => {
  for (const [name, text] of [
    ['provider.js', 'fetch("https://api.twelvedata.com/price")'],
    ['telegram.js', 'fetch("https://api.telegram.org/bot")'],
    ['nested/app.js.map', JSON.stringify({ sourcesContent: ['sb_secret_FAKE_TEST_ONLY'] })],
    ['bot.txt', '123456789:FAKE_TEST_TOKEN_NOT_REAL_ABCDEFGHIJK'],
    ['key.js', '"0123456789abcdef0123456789abcdef"'],
    ['service.js', `"${jwt('service_role')}"`],
    ['destination.json', '{"TELEGRAM_ADMIN_CHAT":"fake-private-destination"}'],
    ['legacy.js', 'window.NEXUS_KEYS=["fake-private-provider"];'],
    ['.env', 'SAFE_PLACEHOLDER=1'], ['server/.env.example', 'placeholder only'],
    ['keys.js', ''], ['package.json', '{}'],
  ]) await t.test(name, t => {
    const f = fixture(t); f.write(name, text);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSING/);
    assert.equal(result.stderr.includes('fake-private-destination'), false, 'diagnostics do not print matched credential material');
    assert.equal(result.stderr.includes('sb_secret_FAKE'), false);
  });
});
test('missing index, root keys.js and symlinks fail closed', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.pub, 'index.html'));
  assert.notEqual(f.run().status, 0);
  f.write('index.html', 'safe');
  fs.writeFileSync(path.join(f.root, 'keys.js'), '');
  assert.notEqual(f.run().status, 0);
  fs.unlinkSync(path.join(f.root, 'keys.js'));
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.pub, 'linked.js'));
  assert.notEqual(f.run().status, 0);
});
