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
    db: async () => ({rpc: async () => ({data:{guard_version:1, account:'twelvedata', daily_limit:700, minute_limit:6, valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved', allowed:true}})}),
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

test('concurrent calls cannot race the six-attempt per-job ceiling', async () => {
  const old=config.twelveDataKeys;config.twelveDataKeys=['offline-job-concurrency'];
  let paid=0;
  limitJobCredits(6);
  try {
    const results=await Promise.allSettled(Array.from({length:20},()=>requestTwelveData('price',{},'worker',{}, {
      db:async()=>({rpc:async()=>({data:{allowed:true,guard_version:1,account:'twelvedata',daily_limit:700,minute_limit:6,valid_for_ms:1000, daily_calls:1, minute_calls:1, reason:'reserved'}})}),
      fetch:async()=>{paid++;return {ok:true,json:async()=>({price:'1.1'})};},
    })));
    assert.equal(paid,6);assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
  } finally {config.twelveDataKeys=old;}
});

test('preflight requires shared quota capability and private bucket without spending credits', async()=>{
  const {preflight}=await import('../src/jobs.js');
  const old={supabaseUrl:config.supabaseUrl,supabaseServiceKey:config.supabaseServiceKey,twelveDataKeys:config.twelveDataKeys};
  Object.assign(config,{supabaseUrl:'https://offline.example.test',supabaseServiceKey:'offline-service-fixture',twelveDataKeys:['offline-provider-fixture']});
  let status={guard_version:1,account:'twelvedata',daily_limit:700,minute_limit:6,rolling_window_seconds:61,initialized:true};
  let bucketPublic=false;const calls=[];
  const client={
    from:()=>({select:()=>({limit:async()=>({data:[]})})}),
    rpc:async name=>{calls.push(name);return {data:status};},
    storage:{getBucket:async()=>({data:{public:bucketPublic}})},
  };
  try{
    const r=await preflight(client);assert.equal(r.verdict,'verified');assert.equal(r.productionReady,false);
    bucketPublic=true;await assert.rejects(preflight(client),/private model bucket/);bucketPublic=false;
    status={...status,initialized:false};await assert.rejects(preflight(client),/shared quota/);
    status=null;await assert.rejects(preflight(client),/shared quota/);
    assert.ok(calls.every(name=>name==='twelvedata_quota_status'));
  }finally{Object.assign(config,old);}
});

test('runMaintenanceJob executes risk, alerts, telegram retries, and housekeeping without paid credits', async()=>{
  const {runMaintenanceJob}=await import('../src/jobs.js');
  const old={supabaseUrl:config.supabaseUrl,supabaseServiceKey:config.supabaseServiceKey};
  Object.assign(config,{supabaseUrl:'https://offline.example.test',supabaseServiceKey:'offline-service-fixture'});
  const order=[];
  try{
    const res=await runMaintenanceJob({
      riskLocked:async()=>{order.push('risk');return {ran:true,result:{rows:12}};},
      runAlertChecks:async()=>{order.push('alerts');return {fired:['win_rate_degraded']};},
      telegramLocked:async()=>{order.push('telegram');return {ran:true,result:{retried:0,sent:0,still_failing:0,deferred:true}};},
      housekeepingLocked:async()=>{order.push('housekeeping');return {ran:true,result:{riskPruned:2}};},
    });
    assert.deepEqual(order,['risk','alerts','telegram','housekeeping']);
    assert.equal(res.verdict,'verified');
    assert.equal(res.riskRows,12);
    assert.equal(res.alertsFired,1);
    assert.equal(res.telegramDeferred,true);
    assert.equal(res.housekeepingRan,true);
  }finally{Object.assign(config,old);}
});

