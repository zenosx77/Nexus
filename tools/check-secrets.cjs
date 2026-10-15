// Heuristic source-tree scan. No secret material is emitted; not a history audit.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
// Exact, path-scoped hashes of existing synthetic redaction fixtures; no file-wide exclusions.
const synthetic={"tests/public-guard.test.cjs": ["3b24205b11a90ef917248a06d0ba9b7ac3b7170faf57a842b7f8d0792279148a"], "tests/smoke.cjs": ["7235aeeaac99307e3c3145c984b2f915f7f9e7214cf847f3c13eeda169502413"]};
let fixtureMatches=0;
let checked=0; const findings=[];
for(const p of paths){
 const b=fs.readFileSync(p);if(b.includes(0))continue;const s=b.toString();checked++;
 let bad=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s)||/\bsb_secret_[a-zA-Z0-9_-]{24,}\b/.test(s);
 for(const token of s.match(/\b\d{7,}:[a-zA-Z0-9_-]{30,}\b/g)||[]){
  if((synthetic[p]||[]).includes(createHash('sha256').update(token).digest('hex')))fixtureMatches++;
  else bad=true;
 }
 for(const token of s.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)||[]){
  try{if(JSON.parse(Buffer.from(token.split('.')[1],'base64url')).role==='service_role')bad=true;}catch{}
 }
 if(bad)findings.push(p);
}
if(findings.length){console.error('Potential private credential in files:',findings.join(', '));process.exit(1);}
console.log(`PASS: ${checked} text files scanned; no recognized private keys, service-role JWTs, Supabase secret keys or Telegram tokens. ${fixtureMatches} exact synthetic test fixtures excluded. Heuristic only; history not scanned.`);
