#!/usr/bin/env node
/* Public Pages artifact guard, not a general-purpose secret scanner.
   Usage: node tools/check-public.cjs <public-dir>
   The Supabase anon/publishable key and relay URL are public configuration.
   Never print matched secrets in diagnostics. Scan every text asset, including
   source maps; prohibit environment/server files and direct provider transport. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pub = process.argv[2] || 'public';
const bad = [];
if (!fs.existsSync(path.join(pub, 'index.html'))) {
  console.error('REFUSING: artifact index.html missing — nothing to check.');
  process.exit(1);
}
if (fs.existsSync('keys.js')) bad.push('keys.js present in repo root at build time');
const rules = [
  ['direct provider/Bot transport', /(?:api\.twelvedata\.com|api\.telegram\.org)/i],
  ['legacy provider key assignment', /window\.NEXUS_KEYS\s*=\s*\[\s*["'](?!your_key["']|["'])[^"']+/i],
  ['legacy Telegram secret/destination assignment', /window\.NEXUS_TG_(?:TOKEN|CHAT)\s*=\s*["'](?!["']|yourchannel["'])[^"']+/i],
  ['server credential/destination assignment', /\b(?:TWELVEDATA_KEYS|TELEGRAM_BOT_TOKEN|TELEGRAM_(?:MAIN|PUBLIC|VIP|LIST|ADMIN|OPS)_CHAT)\b["']?\s*[:=]\s*["']?(?!\s*(?:["']?\s*$|<|your_|placeholder))[^\s"',;]+/im],
  ['service-role configuration', /SUPABASE_SERVICE_ROLE|service_role_key|sbServiceKey|"role"\s*:\s*"service_role"/i],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]+/],
  ['Telegram bot token', /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/],
  ['provider-key-shaped value', /\b[0-9a-f]{32}\b/i],
];
let checked = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const relative = path.relative(pub, file);
    if (entry.isSymbolicLink()) { bad.push(relative + ': symlink is not a public asset'); continue; }
    if (entry.name === 'server' || entry.name === 'trainer' || entry.name === 'supabase' || entry.name === '.git'
        || /^\.env(?:\.|$)/i.test(entry.name) || /^keys(?:\..*)?\.js$/i.test(entry.name)
        || /^(?:config\.json|package(?:-lock)?\.json)$/i.test(entry.name)) {
      bad.push(relative + ': private/source configuration file in public artifact');
      continue;
    }
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.(?:html|js|mjs|cjs|css|json|map|txt|svg|xml|ya?ml|md)$/i.test(entry.name)) continue;
    checked++;
    const src = fs.readFileSync(file, 'utf8');
    for (const [name, re] of rules) if (re.test(src)) bad.push(relative + ': ' + name);
    // Decode JWT payloads so anon JWTs remain allowed, but encoded service-role
    // JWTs cannot evade a plain-text role-name search. No signature validation here.
    for (const match of src.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g)) {
      try {
        const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString());
        if (payload.role === 'service_role') bad.push(relative + ': encoded service-role JWT');
      } catch { /* malformed JWT is not proof of a service-role key */ }
    }
    const legacy = src.match(/const PERMANENT_KEYS\s*=\s*\[([\s\S]*?)\];/);
    if (legacy && [...legacy[1].matchAll(/["']([^"']*)["']/g)].some(m => m[1].trim())) {
      bad.push(relative + ': legacy provider key array is populated');
    }
  }
})(pub);
if (bad.length) {
  console.error('REFUSING TO PUBLISH — unsafe public artifact:\n  - ' + bad.join('\n  - '));
  process.exit(1);
}
console.log('PASS: public artifact guard (' + checked + ' text assets checked; no recognized private credentials or direct provider transport)');
