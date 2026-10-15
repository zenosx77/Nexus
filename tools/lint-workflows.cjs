// Pinned actionlint fork distributed through npm (see package-lock integrity).
// Native upstream download is unavailable in this sandbox. No error suppression.
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const files=fs.readdirSync('.github/workflows').filter(n=>/\.ya?ml$/.test(n)).map(n=>`.github/workflows/${n}`);
const result=spawnSync(process.execPath,['node_modules/@kjanat/actionlint/bin/actionlint.mjs',
  '-shellcheck=','-pyflakes=',...files],{stdio:'inherit'});
if(result.error) console.error(result.error.message);
console.log(`actionlint: ${files.length} workflows; external shellcheck/pyflakes not run`);
process.exitCode=result.status??1;
