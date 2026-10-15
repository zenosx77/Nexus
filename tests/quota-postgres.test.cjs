// Required in verification CI. Locally run npm run test:postgres with an isolated
// loopback DB named nexus_quota_test. NEVER accepts a hosted/production URL.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Client,Pool}=require('pg');
const {quotaCases,reset,rpc}=require('./helpers/quota-cases.cjs');
const connectionString=process.env.NEXUS_TEST_POSTGRES_URL;
if(!connectionString) throw new Error('NEXUS_TEST_POSTGRES_URL required: disposable loopback /nexus_quota_test only');
const url=new URL(connectionString);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)
  || decodeURIComponent(url.hostname)===require('node:path').resolve('.cache'));
assert.equal(url.pathname,'/nexus_quota_test');assert.equal(url.search,'');
test('shared quota real PostgreSQL independent-connection verification',async t=>{
  const db=new Client({connectionString});await db.connect();t.after(()=>db.end());
  // Explicitly disposable DB; do not clean arbitrary schemas on external systems.
  await db.query('drop schema public cascade;create schema public;');
  for(const role of ['anon','authenticated','service_role'])
    await db.query(`do $$ begin create role ${role}; exception when duplicate_object then null; end $$;`);
  await db.query(`alter role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  for(const name of fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort())
    await db.query(fs.readFileSync(`supabase/migrations/${name}`,'utf8'));
  await quotaCases(t,{query:async sql=>{const r=await db.query(sql);return Array.isArray(r)?r.at(-1):r;}});
  const pool=new Pool({connectionString,max:20,connectionTimeoutMillis:5000,application_name:'nexus-quota-race'});
  t.after(()=>pool.end());
  // Monitoring must not share the long-lived lock-holder transaction: PostgreSQL
  // caches pg_stat_activity snapshots until transaction end. Autocommit gives
  // each poll a fresh snapshot without releasing the row-lock barrier.
  const observer=new Client({connectionString,application_name:'nexus-quota-observer'});
  await observer.connect();t.after(()=>observer.end());
  await t.test('40 parallel mixed-scope requests on real connections admit exactly six',async()=>{
    await reset(db);
    await db.query('begin;select * from twelvedata_account_budget for update;');
    // Regression: freeze a zero-waiter statistics snapshot in the lock-holding
    // transaction before contenders connect. CI can naturally hit this timing.
    assert.equal(Number((await db.query("select count(*) as n from pg_stat_activity where application_name='nexus-quota-race' and wait_event_type='Lock'")).rows[0].n),0);
    const jobs=Array.from({length:40},(_,i)=>pool.query(rpc(i%2?'worker':'browser')));
    let results;
    try{
      // Hold the shared row until independent backends demonstrably contend.
      let locked=0;
      for(let i=0;i<50 && locked<4;i++){
        await new Promise(r=>setTimeout(r,20));
        locked=Number((await observer.query("select count(*) as n from pg_stat_activity where application_name='nexus-quota-race' and wait_event_type='Lock'")).rows[0].n);
      }
      assert.ok(locked>=4,`expected >=4 independently blocked connections, got ${locked}`);
    }finally{
      await db.query('commit');
      // Drain contenders even when a monitor assertion fails; otherwise they
      // can mutate counters during the next test's fresh-fixture setup.
      results=await Promise.all(jobs);
    }
    assert.equal(results.filter(r=>r.rows[0].result.allowed).length,6);
    assert.equal(results.filter(r=>r.rows[0].result.reason==='minute-limit').length,34);
    const state=(await db.query('select daily_calls,cardinality(recent_calls) as n from twelvedata_account_budget')).rows[0];
    assert.deepEqual(state,{daily_calls:6,n:6});
  });
  await t.test('parallel day-boundary contention grants only the final account credit',async()=>{
    await reset(db);await db.query('update twelvedata_account_budget set daily_calls=699');
    const results=await Promise.all(Array.from({length:30},(_,i)=>pool.query(rpc(i%2?'worker':'browser'))));
    assert.equal(results.filter(r=>r.rows[0].result.allowed).length,1);
    assert.equal(results.filter(r=>r.rows[0].result.reason==='daily-limit').length,29);
  });
  await t.test('lock timeout fails transaction without granting or consuming a permit',async()=>{
    await reset(db);const blocked=await pool.connect();
    try{
      await db.query('begin;select * from twelvedata_account_budget for update;');
      await blocked.query("set lock_timeout='100ms'");
      await assert.rejects(blocked.query(rpc()),/lock timeout/);
    }finally{await db.query('rollback');await blocked.query('reset lock_timeout');blocked.release();}
    assert.equal((await db.query('select daily_calls from twelvedata_account_budget')).rows[0].daily_calls,0);
  });
  await t.test('real server browser/worker transports share SQL quota before mocked provider calls',async()=>{
    await reset(db);
    const {config}=await import('../server/src/config.js');
    const {requestTwelveData}=await import('../server/src/twelvedata.js');
    const old=config.twelveDataKeys;config.twelveDataKeys=['offline-quota-integration'];
    let paid=0;
    try{
      const results=await Promise.allSettled(Array.from({length:24},(_,i)=>requestTwelveData('price',{symbol:'EUR/USD'},i%2?'worker':'browser',{}, {
        db:async()=>({rpc:async(name,p)=>{
          assert.equal(name,'reserve_twelvedata_account_credit');
          const r=await pool.query('select reserve_twelvedata_account_credit($1,$2,$3,$4,$5) as result',
            [p.p_scope,p.p_daily_limit,p.p_minute_limit,p.p_category??'scan',p.p_scan_reserve??0]);
          return {data:r.rows[0].result};
        }}),
        fetch:async()=>{paid++;return {ok:true,json:async()=>({price:'1.1'})};},
      })));
      assert.equal(paid,6);assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
      assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.reason==='minute-limit').length,18);
    }finally{config.twelveDataKeys=old;}
  });
  await t.test('rollback after reservation releases row safely; next transaction remains consistent',async()=>{
    await reset(db);await db.query('begin');
    assert.equal((await db.query(rpc())).rows[0].result.allowed,true);
    await db.query('rollback');
    assert.equal((await pool.query(rpc('browser'))).rows[0].result.daily_calls,1);
  });
});
