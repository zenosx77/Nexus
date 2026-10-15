import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvaluate } from '../src/evaluate.js';
const target = Date.parse('2026-01-01T00:00:00Z');
function fixture({age=30, candles=[], failure=null, duplicate=false, badReadback=false}={}) {
  let writes = 0, saved;
  const calls=[];
  const client = {from(table) {
    let inserting=false;
    const q = new Proxy({}, {get(_o,key) {
      if(key==='then') return resolve => {
        if(failure===table) return resolve({error:{code:'XX'}});
        if(table==='v_prediction_accuracy') return resolve({data:[{id:'p',pair_code:'EUR/USD',target_open_ts:new Date(target).toISOString(),direction:'CALL'}]});
        if(table==='predictions') return resolve({data:[{id:'p',evaluation_horizon:1}]});
        if(table==='currency_pairs') return resolve({data:[{code:'EUR/USD',spread_bps:1}]});
        if(table==='market_candles') return resolve({data: candles});
        if(table==='trade_outcomes' && inserting) {writes++; return resolve(duplicate?{error:{code:'23505'}}:{});}
        if(table==='trade_outcomes') return resolve({data: badReadback?{}:saved});
        throw new Error('unexpected table');
      };
      return (...args) => {calls.push([table,key,...args]);if(key==='insert'){inserting=true;saved=args[0];}return q;};
    }});
    return q;
  }};
  return {run:()=>runEvaluate({now:target+(age+1)*60000,db:async()=>client}),get writes(){return writes;},calls};
}
test('missing candles defer until 90 minutes then persist invalid with readback', async () => {
  const waiting=fixture({age:89}); const r=await waiting.run();
  assert.equal(r.skipped,1); assert.equal(waiting.writes,0);
  const expired=fixture({age:90}); assert.equal((await expired.run()).invalid,1);
  assert.equal(expired.writes,1);
});
test('settlement reads actual horizon and exact timestamps, then verifies stored outcome', async () => {
  const f=fixture({candles:[{ts:new Date(target).toISOString(),open:1,close:1.01}]});
  assert.equal((await f.run()).evaluated,1);
  assert.ok(f.calls.some(c=>c[0]==='predictions'&&c[1]==='select'&&c[2].includes('evaluation_horizon')));
  assert.ok(f.calls.some(c=>c[0]==='market_candles'&&c[1]==='in'&&c[2]==='ts'));
  assert.ok(!f.calls.some(c=>c[0]==='v_prediction_accuracy'&&c[1]==='select'&&c[2].includes('evaluation_horizon')));
});
test('settlement database failures and mismatched readback reject rather than succeed', async () => {
  for(const failure of ['v_prediction_accuracy','predictions','currency_pairs','market_candles','trade_outcomes']) {
    await assert.rejects(fixture({age:100,failure}).run());
  }
  await assert.rejects(fixture({age:100,badReadback:true}).run(), /readback/);
});
test('unique violation defers duplicate settlement without overwrite', async () => {
  const f=fixture({age:100,duplicate:true}); const r=await f.run();
  assert.equal(r.skipped,1);assert.equal(r.invalid,0);
  assert.ok(!f.calls.some(c=>c[1]==='upsert'||c[1]==='update'));
});
