import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../src/jobs.js';
import { config } from '../src/config.js';
import { limitJobCredits, requestTwelveData } from '../src/twelvedata.js';

test('job verdict distinguishes readback, stale, deferred and failure', () => {
  assert.equal(verdict({ran:false}, 'job-ingest').verdict, 'deferred');
  assert.equal(verdict({ran:true,result:[]}, 'job-ingest').verdict, 'deferred');
  assert.throws(() => verdict({ran:true,result:[{error:'failed'}]}, 'job-ingest'));
  assert.throws(() => verdict({ran:true,result:[{upserted:10}]}, 'job-ingest'));
  assert.throws(() => verdict({ran:true,result:[{error:'DB',budgetLimited:true,budgetReason:'guard-unavailable'}]}, 'job-ingest'));
  const r = verdict({ran:true,result:[{verified:true,stale:true}]}, 'job-ingest');
  assert.equal(r.stale, 1);
  assert.equal(r.verified, 1);
  assert.equal(verdict({ran:true,result:{due:1,evaluated:0,invalid:0,skipped:1}}, 'job-outcomes').verdict, 'deferred');
});
test('scheduled credit ceiling includes every paid attempt across minute boundaries', async () => {
  const old = config.twelveDataKeys;
  config.twelveDataKeys = ['offline-test-key'];
  let paid = 0;
  const deps = {
    db: async () => ({rpc: async () => ({data:{allowed:true}})}),
    fetch: async () => {paid++; return {ok:true,json:async()=>({values:[]})};},
  };
  try {
    limitJobCredits(6);
    for(let i=0;i<6;i++) await requestTwelveData('time_series', {}, 'worker', {}, deps);
    await assert.rejects(requestTwelveData('time_series', {}, 'worker', {}, deps), /cap reached/);
    assert.equal(paid,6);
  } finally { config.twelveDataKeys = old; }
});
test('missing candles have at least a 90-minute settlement window', () => {
  assert.ok(config.evaluationMaxDelayMinutes >= 90);
});
