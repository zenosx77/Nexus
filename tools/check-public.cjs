#!/usr/bin/env node
/* Credential guard for the published GitHub Pages site.
   Usage: node tools/check-public.cjs <public-dir>
   Fails (exit 1) if the site would leak API keys or bot tokens:
     - keys.js copied into the public dir (or present in repo root at build time)
     - non-empty PERMANENT_KEYS entries embedded in the published HTML
     - non-empty window.NEXUS_KEYS / NEXUS_TG_TOKEN / NEXUS_TG_CHAT assignments
     - any Supabase SERVICE-ROLE key material (the anon key is public by design;
       the service-role key is full database access and must never be deployed)
   Documentation examples with empty strings ("") or the placeholder
   ["your_key"] inside comments do NOT count as embedded credentials,
   but any real-looking assignment does. */
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

/* 1) in-file PERMANENT_KEYS array must be all empty strings */
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
