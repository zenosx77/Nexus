#!/usr/bin/env node
/* Credential/transport guard for the public GitHub Pages artifact.
   Usage: node tools/check-public.cjs <public-dir>
   Fails if the site would publish a key/token or bypass the server relay:
     - keys.js copied into the public dir (or present in repo root at build time)
     - old browser key arrays or Telegram token/chat assignments
     - Supabase service-role material
     - direct Twelve Data or Telegram Bot API host references in browser code
   The Supabase anon key and NEXUS API base URL are public configuration. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const pub = process.argv[2] || 'public';
const bad = [];

if (!fs.existsSync(path.join(pub, 'index.html'))) {
  console.error('REFUSING: ' + pub + '/index.html missing — nothing to check.');
  process.exit(1);
}
if (fs.existsSync(path.join(pub, 'keys.js'))) bad.push('keys.js present in public dir');
if (fs.existsSync('keys.js')) bad.push('keys.js present in repo root at build time');

const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

if (/https?:\/\/(?:api\.twelvedata\.com|api\.telegram\.org)/i.test(html)) {
  bad.push('browser code contains a direct provider/Bot API host; route through the NEXUS server relay');
}

/* 1) legacy in-file PERMANENT_KEYS array must be all empty strings */
const pk = html.match(/const PERMANENT_KEYS\s*=\s*\[([\s\S]*?)\];/);
if (pk) {
  const vals = [...pk[1].matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(v => v.trim());
  if (vals.length) bad.push('PERMANENT_KEYS embeds ' + vals.length + ' real key(s)');
}

/* 2) any real (non-empty, non-placeholder) credential assignment in published files */
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|js|css|json|txt)$/i.test(e.name)) files.push(p);
  }
})(pub);
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const re of [
    /window\.NEXUS_KEYS\s*=\s*\[\s*"(?!your_key")[^"]+"/g,
    /window\.NEXUS_TG_TOKEN\s*=\s*"(?!")[^"]+"/g,
    /window\.NEXUS_TG_CHAT\s*=\s*"(?!yourchannel)[^"]+"/g,
    /\b(?:TWELVEDATA_KEYS|TELEGRAM_BOT_TOKEN|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*["'](?!<|your_|placeholder)[^"']+/i,
    /* cloud: anon key is public BY DESIGN; service-role key material is fatal */
    /SUPABASE_SERVICE_ROLE/i,
    /service_role_key/i,
    /"role"\s*:\s*"service_role"/,
    /sbServiceKey/i,
  ]) {
    const m = re.exec(src);
    if (m) bad.push(f + ' embeds a credential: ' + String(m[0]).slice(0, 40) + '…');
  }
}

if (bad.length) {
  console.error('REFUSING TO PUBLISH — credentials must never be deployed:\n  - ' + bad.join('\n  - '));
  process.exit(1);
}
console.log('✅ credential guard: no keys or tokens embedded in ' + pub + ' (' + files.length + ' files checked)');
