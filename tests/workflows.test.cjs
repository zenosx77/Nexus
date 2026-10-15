const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('scheduled workflow safety contracts', () => {
  for (const file of ['nexus-data-jobs.yml','nexus-train.yml']) {
    const s = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
    assert.match(s, /vars.NEXUS_SCHEDULE_ENABLED == 'true'/);
    assert.match(s, /github.ref == 'refs\/heads\/main'/);
    assert.match(s, /group: nexus-production-jobs/);
    assert.match(s, /cancel-in-progress: false/);
    assert.match(s, /contents: read/);
    assert.doesNotMatch(s, /pull_request|TELEGRAM|write-all/);
    for(const [,ref] of s.matchAll(/uses: ([^\s]+)/g)) assert.match(ref, /@[a-f0-9]{40}$/);
  }
  const s = fs.readFileSync('.github/workflows/nexus-data-jobs.yml','utf8');
  assert.match(s, /7,37 \* \* \* \*/);
  assert.match(s, /options: \[preflight-only, ingest-only, outcomes-only, backfill-only\]/);
  const scheduled = s.split('if [ "$EVENT" = schedule ]; then')[1].split('else')[0];
  assert.doesNotMatch(scheduled, /backfill/);
});

test('verification CI runs real PostgreSQL without production secrets',()=>{
  const s=fs.readFileSync('.github/workflows/verify.yml','utf8');
  assert.match(s,/npm run test:postgres/);assert.match(s,/npm test/);
  assert.match(s,/image: postgres:17\.6/);assert.match(s,/contents: read/);
  assert.doesNotMatch(s,/secrets\.|pull_request_target|SUPABASE|TWELVEDATA_KEYS|TELEGRAM/);
  for(const [,ref] of s.matchAll(/uses: ([^\s]+)/g)) assert.match(ref,/@[a-f0-9]{40}$/);
});
