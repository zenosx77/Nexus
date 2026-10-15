// Disposable in-memory PostgreSQL (PGlite), no DB URL, sockets or hosted access.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const migrationDir = 'supabase/migrations';
const verify = fs.readFileSync('supabase/verify/0008_read_only.sql', 'utf8');

test('migrations 0001–0008 and security/budget behavior in disposable PostgreSQL', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  // Model the broad Supabase-style initial grants so 0008 must actually revoke them.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    revoke create on schema public from public;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to service_role;`);
  const migrations = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();
  assert.equal(migrations.length, 8);
  for (const name of migrations) await db.exec(fs.readFileSync(`${migrationDir}/${name}`, 'utf8'));
  await t.test('0008 reapplies without relaxing grants and read-only verifier passes', async () => {
    await db.exec(fs.readFileSync(`${migrationDir}/0008_cloud_security_and_browser_budget.sql`, 'utf8'));
    await db.exec(verify);
  });
  const asRole = async (role, sql) => {
    await db.exec(`set role ${role}`);
    try { return await db.query(sql); }
    finally { await db.exec('reset role'); }
  };
  await t.test('anon/authenticated cannot forge deliveries, alter operational data or call maintenance/budget RPCs', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const sql of [
        'select * from telegram_deliveries',
        "insert into telegram_deliveries(channel,chat_id,status,attempts,payload,server_managed) values('main','main','failed',1,'forged',true)",
        "update system_settings set value='1'::jsonb", 'delete from job_locks',
        'select reserve_twelvedata_credit(700,6)',
        "select reserve_twelvedata_browser_credit(700,7,'scan',0)",
        "select try_job_lock('test','test',60)", 'select prune_operational_logs(1)',
      ]) await assert.rejects(asRole(role, sql), /permission denied/);
      const safe = await asRole(role, 'select * from v_deliveries_public');
      assert.equal(safe.rows.length, 0);
    }
  });
  await t.test('shared prediction mirror remains insert/read-only, with RLS blocking shadow/worker writes', async () => {
    const prediction = "insert into predictions(pair_code,target_open_ts,direction,confidence,source,is_shadow) values('EUR/USD','2026-10-15T12:00:00Z','CALL',60,'browser',false)";
    await asRole('anon', prediction);
    assert.equal((await asRole('authenticated', 'select * from predictions')).rows.length, 1);
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(role, prediction.replace("'browser',false", "'worker',true")), /row-level security/);
      await assert.rejects(asRole(role, 'delete from predictions'), /permission denied/);
      await assert.rejects(asRole(role, "update predictions set direction='PUT'"), /permission denied/);
    }
  });
  await t.test('historic delivery provenance defaults false; service rows and safe views do not expose payloads', async () => {
    await asRole('service_role', "insert into telegram_deliveries(channel,chat_id,payload,status,attempts) values('main','legacy-private','legacy payload','failed',1)");
    await asRole('service_role', "insert into telegram_deliveries(channel,chat_id,payload,status,attempts,server_managed) values('main','main','server payload','failed',1,true)");
    const raw = await asRole('service_role', 'select server_managed from telegram_deliveries order by created_at');
    assert.deepEqual(raw.rows.map(r => r.server_managed), [false, true]);
    const safe = await asRole('anon', 'select * from v_deliveries_public');
    assert.equal(safe.rows.length, 2);
    assert.equal(/legacy-private|legacy payload|server payload/.test(JSON.stringify(safe)), false);
  });
  const reserve = async (scope, category = 'settlement', scanReserve = 0) => {
    const sql = scope === 'worker' ? 'select reserve_twelvedata_credit(700,6) as result'
      : `select reserve_twelvedata_browser_credit(700,7,'${category}',${scanReserve}) as result`;
    return (await asRole('service_role', sql)).rows[0].result;
  };
  const setCounter = (scope, daily, minute) => db.exec(`update twelvedata_${scope === 'browser' ? 'browser_' : ''}credit_budget
    set usage_day=(clock_timestamp() at time zone 'UTC')::date, daily_calls=${daily},
    minute_bucket=to_timestamp(floor(extract(epoch from clock_timestamp())/60)*60), minute_calls=${minute}`);
  await t.test('absolute 700/day and 7/min browser / 6/min worker caps, separate pools and UTC rollover', async () => {
    for (const scope of ['browser', 'worker']) {
      await reserve(scope);
      await setCounter(scope, 699, 0);
      assert.equal((await reserve(scope)).allowed, true);
      assert.equal((await reserve(scope)).reason, 'daily-limit');
      await setCounter(scope, 0, scope === 'browser' ? 6 : 5);
      assert.equal((await reserve(scope)).allowed, true);
      assert.equal((await reserve(scope)).reason, 'minute-limit');
      await db.exec(`update twelvedata_${scope === 'browser' ? 'browser_' : ''}credit_budget
        set usage_day=(clock_timestamp() at time zone 'UTC')::date-1, daily_calls=700,
        minute_bucket=clock_timestamp()-interval '2 minutes', minute_calls=7`);
      const reset = await reserve(scope);
      assert.equal(reset.allowed, true);
      assert.equal(reset.daily_calls, 1);
      assert.equal(reset.minute_calls, 1);
    }
    await setCounter('worker', 700, 6);
    await setCounter('browser', 0, 0);
    assert.equal((await reserve('browser')).allowed, true);
    assert.equal((await reserve('worker')).reason, 'daily-limit');
  });
  await t.test('browser routine requests stop at 560/day, settlement has headroom; ticker respects scan reserve', async () => {
    await setCounter('browser', 560, 0);
    assert.equal((await reserve('browser', 'scan')).reason, 'settlement-reserve');
    assert.equal((await reserve('browser', 'ticker')).reason, 'settlement-reserve');
    assert.equal((await reserve('browser', 'settlement')).allowed, true);
    await setCounter('browser', 0, 4);
    assert.equal((await reserve('browser', 'ticker', 3)).reason, 'minute-limit');
    assert.equal((await reserve('browser', 'scan')).allowed, true);
  });
  await t.test('invalid RPC arguments reject; queued reservations cannot overrun caps', async () => {
    await assert.rejects(asRole('service_role', "select reserve_twelvedata_browser_credit(700,7,'bad',0)"), /invalid/);
    await assert.rejects(asRole('service_role', 'select reserve_twelvedata_credit(-1,6)'), /non-negative/);
    await setCounter('browser', 0, 0);
    // PGlite serializes one connection. This is not a multi-connection lock stress test.
    const results = await Promise.all(Array.from({ length: 12 }, () => db.query("select reserve_twelvedata_browser_credit(700,7,'settlement',0) as result")));
    assert.equal(results.filter(r => r.rows[0].result.allowed).length, 7);
    const sql = fs.readFileSync(`${migrationDir}/0008_cloud_security_and_browser_budget.sql`, 'utf8');
    assert.match(sql, /for update;/i, 'database row lock is present; multi-connection concurrency remains a staging check');
  });
});
