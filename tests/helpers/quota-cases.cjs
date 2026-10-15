// Shared SQL assertions: runs against PGlite and a disposable real PostgreSQL.
// State mutation here is test-fixture setup only, NEVER a recovery procedure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const migration=fs.readFileSync('supabase/migrations/0009_shared_account_quota.sql','utf8');
const rpc=(scope='worker',daily=700,minute=6,category='settlement',reserve=0)=>
  `select public.reserve_twelvedata_account_credit('${scope}',${daily},${minute},'${category}',${reserve}) as result`;
const reset=async db=>{
  await db.query(`update public.twelvedata_account_budget set usage_day=(clock_timestamp() at time zone 'UTC')::date,
    daily_calls=0,recent_calls='{}',blocked_until=clock_timestamp()-interval '1 day',updated_at=clock_timestamp()-interval '1 second';
    delete from public.twelvedata_credit_budget; delete from public.twelvedata_browser_credit_budget;`);
};
async function quotaCases(t,db){
  const reserve=async (...args)=>(await db.query(rpc(...args))).rows[0].result;
  await t.test('migration quarantines initial day and reapplication never resets credits',async()=>{
    const first=await reserve();assert.equal(first.allowed,false);assert.equal(first.reason,'daily-limit');
    await reset(db);await reserve();
    await db.query(migration);
    assert.equal((await db.query('select daily_calls from twelvedata_account_budget')).rows[0].daily_calls,1);
  });
  await t.test('700th combined worker/browser credit succeeds; 701st cannot increase counters',async()=>{
    await reset(db);
    await db.query('update twelvedata_account_budget set daily_calls=699');
    const last=await reserve('browser');assert.equal(last.allowed,true);assert.equal(last.daily_calls,700);
    const denied=await reserve('worker');assert.equal(denied.allowed,false);assert.equal(denied.reason,'daily-limit');
    assert.equal(denied.daily_calls,700);
  });
  await t.test('all scopes share six permits and oversized caller limits cannot raise hard caps',async()=>{
    await reset(db);
    for(let i=0;i<6;i++) assert.equal((await reserve(i%2?'worker':'browser',999999,999999)).allowed,true);
    const blocked=await reserve('worker',999999,999999);assert.equal(blocked.reason,'minute-limit');
    assert.equal(blocked.daily_calls,6);assert.equal(blocked.minute_calls,6);
    assert.equal(blocked.daily_limit,700);assert.equal(blocked.minute_limit,6);
  });
  await t.test('legacy worker/browser RPCs have no independent-account bypass',async()=>{
    await reset(db);
    for(let i=0;i<6;i++){
      const sql=i%2 ? 'select reserve_twelvedata_credit(700,100) as result' : "select reserve_twelvedata_browser_credit(700,100,'settlement',0) as result";
      assert.equal((await db.query(sql)).rows[0].result.allowed,true);
    }
    assert.equal((await reserve()).reason,'minute-limit');
  });
  await t.test('UTC rollover resets day count but never the rolling minute window',async()=>{
    await reset(db);
    await db.query(`update twelvedata_account_budget set usage_day=(clock_timestamp() at time zone 'UTC')::date-1,
      daily_calls=700,recent_calls=array_fill(clock_timestamp(),array[6]);`);
    const r=await reserve();assert.equal(r.reason,'minute-limit');assert.equal(r.daily_calls,0);
    await db.query("update twelvedata_account_budget set recent_calls=array_fill(clock_timestamp()-interval '62 seconds',array[6])");
    const next=await reserve('browser');assert.equal(next.allowed,true);assert.equal(next.daily_calls,1);
  });
  await t.test('rolling boundary retains 60-second-old reservations; expires after 61 seconds',async()=>{
    await reset(db);
    await db.query("update twelvedata_account_budget set recent_calls=array_fill(clock_timestamp()-interval '60 seconds',array[6])");
    assert.equal((await reserve('browser')).reason,'minute-limit');
    await db.query("update twelvedata_account_budget set recent_calls=array_fill(clock_timestamp()-interval '61.1 seconds',array[6])");
    assert.equal((await reserve()).allowed,true);
  });
  await t.test('browser settlement headroom and stricter configured limits remain enforced',async()=>{
    await reset(db);await reserve('browser');
    await db.query('update twelvedata_browser_credit_budget set daily_calls=560');
    assert.equal((await reserve('browser',700,6,'scan')).reason,'settlement-reserve');
    assert.equal((await reserve('browser',700,6,'settlement')).allowed,true);
    assert.equal((await reserve('worker',0,6)).reason,'daily-limit');
    assert.equal((await reserve('worker',700,0)).reason,'minute-limit');
    await reset(db);
    assert.equal((await reserve('browser',700,6,'ticker',6)).reason,'minute-limit');
  });
  await t.test('invalid inputs and missing/clock-regressed state fail closed',async()=>{
    await reset(db);
    for(const sql of [rpc('other'),rpc('worker',-1),rpc('worker',700,-1),rpc('browser',700,6,'other'),rpc('browser',700,6,'scan',-1)])
      await assert.rejects(db.query(sql),/invalid/);
    await db.query("update twelvedata_account_budget set updated_at=clock_timestamp()+interval '1 hour'");
    await assert.rejects(reserve(),/clock regressed/);
    await reset(db);
    await db.query('begin; delete from twelvedata_account_budget;');
    await assert.rejects(reserve(),/unavailable/);
    await db.query('rollback');
  });
  await t.test('failed transaction rolls back both account and scope changes atomically',async()=>{
    await reset(db);
    await db.query(`create function public.quota_test_failure() returns trigger language plpgsql as $$
      begin raise exception 'injected quota write failure'; end $$;
      create trigger quota_test_failure before update on public.twelvedata_credit_budget
      for each row execute function public.quota_test_failure();`);
    try{await assert.rejects(reserve(),/injected/);}finally{
      await db.query('drop trigger quota_test_failure on twelvedata_credit_budget; drop function quota_test_failure();');
    }
    assert.equal((await db.query('select daily_calls from twelvedata_account_budget')).rows[0].daily_calls,0);
    assert.equal((await db.query('select count(*)::integer as n from twelvedata_credit_budget')).rows[0].n,0);
  });
  await t.test('anon/authenticated cannot inspect/reserve; service cannot mutate/reset quota tables',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      await db.query(`set role ${role}`);
      try{
        for(const table of ['twelvedata_account_budget','twelvedata_credit_budget','twelvedata_browser_credit_budget']){
          for(const sql of [`delete from ${table}`,`update ${table} set daily_calls=0`,`truncate ${table}`])
            await assert.rejects(db.query(sql),/permission denied/);
          if(role!=='service_role') await assert.rejects(db.query(`select * from ${table}`),/permission denied/);
        }
        if(role!=='service_role'){
          for(const sql of [rpc(),'select reserve_twelvedata_credit(700,6)',"select reserve_twelvedata_browser_credit(700,6,'settlement',0)",'select twelvedata_quota_status()'])
            await assert.rejects(db.query(sql),/permission denied/);
        }else{
          const s=(await db.query('select twelvedata_quota_status() as s')).rows[0].s;
          assert.equal(s.guard_version,1);assert.equal(s.initialized,true);
          assert.equal((await db.query(rpc())).rows[0].result.allowed,true);
        }
      }finally{await db.query('reset role');}
    }
  });
  await t.test('read-only status does not spend quota and corruption violates constraints',async()=>{
    await reset(db);
    await db.query(fs.readFileSync('supabase/verify/0008_read_only.sql','utf8'));
    await db.query(fs.readFileSync('supabase/verify/0009_read_only.sql','utf8'));
    assert.equal((await db.query('select daily_calls from twelvedata_account_budget')).rows[0].daily_calls,0);
    await assert.rejects(db.query('update twelvedata_account_budget set daily_calls=701'),/check constraint/);
    await assert.rejects(db.query("update twelvedata_account_budget set recent_calls=array_fill(clock_timestamp(),array[7])"),/check constraint/);
  });
}
module.exports={quotaCases,reset,rpc};
