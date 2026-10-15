#!/usr/bin/env node
// Local-only assembly matching the existing Pages workflow's explicit file list.
// Never copies the repository, .env, server sources or public config scripts.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../.cache/public');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'assets/fonts'), { recursive: true });
for (const file of ['index.html', 'assets/fonts/inter-latin-wght-normal.woff2', 'assets/fonts/INTER-OFL-LICENSE.txt']) {
  fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(output, file));
}
console.log('Local Pages artifact assembled at .cache/public (no deployment)');
