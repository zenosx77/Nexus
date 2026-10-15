'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

test('environment template exactly covers actual server configuration names, with safe limits/placeholders', () => {
  const source = fs.readFileSync('server/src/config.js', 'utf8');
  const actual = new Set([...source.matchAll(/(?:num|bool|list|positiveInt)\('([A-Z][A-Z0-9_]+)'|process\.env\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1] || m[2]));
  const text = fs.readFileSync('server/.env.example', 'utf8');
  const entries = [...text.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)];
  assert.deepEqual(entries.map(m => m[1]).sort(), [...actual].sort(), 'no invented or missing environment variables');
  const values = Object.fromEntries(entries.map(m => [m[1], m[2].split(/\s+#/)[0].trim()]));
  assert.equal(values.TWELVEDATA_BROWSER_DAILY_CREDIT_LIMIT, '700');
  assert.equal(values.TWELVEDATA_BROWSER_PER_MINUTE_LIMIT, '7');
  assert.equal(values.TWELVEDATA_DAILY_CREDIT_LIMIT, '700');
  assert.equal(values.TWELVEDATA_PER_MINUTE_LIMIT, '6');
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'TWELVEDATA_KEYS', 'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_MAIN_CHAT', 'TELEGRAM_PUBLIC_CHAT', 'TELEGRAM_VIP_CHAT', 'TELEGRAM_LIST_CHAT', 'TELEGRAM_ADMIN_CHAT', 'TELEGRAM_OPS_CHAT', 'NEXUS_TELEGRAM_ADMIN_USER_IDS']) {
    assert.match(values[name], /^<[^>]+>(?:,<[^>]+>)*$/, name + ' must be placeholder-only');
  }
  const pkg = JSON.parse(fs.readFileSync('server/package.json'));
  const lock = JSON.parse(fs.readFileSync('server/package-lock.json'));
  assert.equal(pkg.engines.node, '>=22');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
});

test('dotenv handles comments/quotes and never overwrites host environment', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-env-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync('server/src/env.js', path.join(root, 'src/env.mjs'));
  fs.writeFileSync(path.join(root, '.env'), 'WORKER_POLL_SECONDS=30 # comment\nINGEST_PAIRS="EUR/USD,GBP/USD"\nLOG_LEVEL=info # comment\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/env.mjs')).href)}); console.log(JSON.stringify([process.env.WORKER_POLL_SECONDS,process.env.INGEST_PAIRS,process.env.LOG_LEVEL]));`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, WORKER_POLL_SECONDS: '45' } });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), ['45', 'EUR/USD,GBP/USD', 'info']);
});
