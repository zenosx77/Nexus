// ── minimal .env loader (no dependency) ─────────────────────────────────
// Loads server/.env when present. Real environment variables always win.
// Must be the first import of config.js so env vars exist at config build time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
try {
  const txt = fs.readFileSync(envPath, 'utf8');
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
    if (quoted) val = val.slice(1, -1);
    else {
      const comment = val.search(/\s+#|^#/);
      if (comment >= 0) val = val.slice(0, comment).trim();
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch { /* no .env — rely on real env */ }
