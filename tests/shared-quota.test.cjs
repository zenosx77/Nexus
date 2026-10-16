const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const {quotaCases}=require('./helpers/quota-cases.cjs');
test('shared quota migration 0009 in disposable PostgreSQL (PGlite)',async t=>{
  const pg=new PGlite({extensions:{pgcrypto}});t.after(()=>pg.close());
  await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  const migrations=fs.readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort();
  for(const name of migrations.filter(n=>!n.startsWith('0009_')))
    await pg.exec(fs.readFileSync(`supabase/migrations/${name}`,'utf8'));
  await t.test('pre-0009 database passes 0008 verifier and fails 0009 verifier with explicit missing-0009 error',async()=>{
    await pg.exec(fs.readFileSync('supabase/verify/0008_read_only.sql','utf8'));
    await assert.rejects(
      pg.exec(fs.readFileSync('supabase/verify/0009_read_only.sql','utf8')),
      /0009 missing: shared account quota migration 0009_shared_account_quota\.sql is not applied/,
    );
    await pg.exec('rollback;');
  });
  await pg.exec(fs.readFileSync('supabase/migrations/0009_shared_account_quota.sql','utf8'));
  // PGlite's prepared-query API rejects multiple statements. exec returns their results.
  const db={query:async sql=>(await pg.exec(sql)).at(-1)};
  await quotaCases(t,db);
  await t.test('preflight selects real migrated schema columns and reads the shared contract',async()=>{
    const {preflight}=await import('../server/src/jobs.js');
    const {config}=await import('../server/src/config.js');
    const old={supabaseUrl:config.supabaseUrl,supabaseServiceKey:config.supabaseServiceKey,twelveDataKeys:config.twelveDataKeys};
    Object.assign(config,{supabaseUrl:'https://offline.example.test',supabaseServiceKey:'offline-fixture',twelveDataKeys:['offline-fixture']});
    try{
      const result=await preflight({
        from:table=>({select:columns=>({limit:async n=>({data:(await db.query(`select ${columns} from public.${table} limit ${n}`)).rows})})}),
        rpc:async name=>({data:(await db.query(`select public.${name}() as result`)).rows[0].result}),
        storage:{getBucket:async()=>({data:{public:false}})}, // storage metadata alone is mocked
      });
      assert.equal(result.verdict,'verified');assert.equal(result.productionReady,false);
    }finally{Object.assign(config,old);}
  });
  await t.test('management API read-only role (supabase_read_only_user) passes 0008 and 0009 verifiers without RPC EXECUTE',async()=>{
    await pg.exec('create role supabase_read_only_user bypassrls; grant pg_read_all_data to supabase_read_only_user;');
    try {
      await pg.exec('set role supabase_read_only_user;');
      await pg.exec(fs.readFileSync('supabase/verify/0008_read_only.sql','utf8'));
      await pg.exec(fs.readFileSync('supabase/verify/0009_read_only.sql','utf8'));
    } finally {
      await pg.exec('reset role;');
    }
  });
});
