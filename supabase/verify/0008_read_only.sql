-- READ-ONLY verification, not a migration. Run against an explicitly confirmed
-- staging project as its database administrator. No provider credit is reserved.
-- Passing proves these schema/privilege properties, not hosted Auth/proxy settings.
begin transaction read only;

do $$
declare
  v_role text;
  v_table text;
  v_function text;
  v_column text;
begin
  if to_regclass('public.twelvedata_browser_credit_budget') is null then
    raise exception '0008 missing: browser credit budget table';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'telegram_deliveries' and column_name = 'server_managed'
      and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception '0008 missing/incorrect: server_managed boolean NOT NULL DEFAULT false';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
      and tablename = 'telegram_deliveries' and cmd in ('INSERT','ALL')) then
    raise exception 'Unsafe delivery INSERT/ALL policy remains';
  end if;

  foreach v_role in array array['anon','authenticated'] loop
    if has_schema_privilege(v_role, 'public', 'CREATE') then
      raise exception 'Unsafe CREATE on public schema for %', v_role;
    end if;
    foreach v_table in array array['telegram_deliveries','system_settings','alert_log',
        'job_locks','ingestion_runs','training_runs','trade_outcome_revisions',
        'twelvedata_credit_budget','twelvedata_browser_credit_budget'] loop
      if has_table_privilege(v_role, 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'Unsafe operational table privilege: % / %', v_role, v_table;
      end if;
    end loop;
    foreach v_table in array array['currency_pairs','market_candles','market_features',
        'predictions','trade_outcomes','model_versions','risk_snapshots'] loop
      if not has_table_privilege(v_role, 'public.' || v_table, 'SELECT') then
        raise exception 'Missing intended shared read: % / %', v_role, v_table;
      end if;
      if has_table_privilege(v_role, 'public.' || v_table, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'Unsafe shared table privilege: % / %', v_role, v_table;
      end if;
      if v_table <> 'predictions' and has_table_privilege(v_role, 'public.' || v_table, 'INSERT') then
        raise exception 'Unsafe shared INSERT: % / %', v_role, v_table;
      end if;
    end loop;
    if not has_table_privilege(v_role, 'public.predictions', 'INSERT') then
      raise exception 'Missing intended shared prediction INSERT for %', v_role;
    end if;
    foreach v_table in array array['v_deliveries_public','v_ingestion_health_public','v_market_freshness','v_prediction_accuracy'] loop
      if not has_table_privilege(v_role, 'public.' || v_table, 'SELECT') then
        raise exception 'Missing safe view SELECT: % / %', v_role, v_table;
      end if;
      if has_table_privilege(v_role, 'public.' || v_table, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'Unsafe public view write privilege: % / %', v_role, v_table;
      end if;
    end loop;
    foreach v_function in array array[
        'reserve_twelvedata_credit(integer,integer)',
        'reserve_twelvedata_browser_credit(integer,integer,text,integer)',
        'try_job_lock(text,text,integer)','release_job_lock(text,text)',
        'prune_market_candles(integer)','prune_operational_logs(integer)',
        'prune_risk_snapshots()','prune_job_locks()'] loop
      if has_function_privilege(v_role, 'public.' || v_function, 'EXECUTE') then
        raise exception 'Unsafe RPC EXECUTE: % / %', v_role, v_function;
      end if;
      if not has_function_privilege('service_role', 'public.' || v_function, 'EXECUTE') then
        raise exception 'Missing service-role RPC EXECUTE: %', v_function;
      end if;
    end loop;
  end loop;

  foreach v_table in array array['currency_pairs','market_candles','market_features','predictions',
      'trade_outcomes','trade_outcome_revisions','model_versions','training_runs','risk_snapshots',
      'ingestion_runs','telegram_deliveries','system_settings','alert_log','job_locks',
      'twelvedata_credit_budget','twelvedata_browser_credit_budget'] loop
    if not exists (select 1 from pg_class where oid = ('public.' || v_table)::regclass and relrowsecurity) then
      raise exception 'RLS disabled: %', v_table;
    end if;
    if not has_table_privilege('service_role', 'public.' || v_table, 'SELECT') then
      raise exception 'Missing service-role read access: %', v_table;
    end if;
    if to_regclass('public.twelvedata_account_budget') is not null
       and v_table in ('twelvedata_credit_budget','twelvedata_browser_credit_budget') then
      -- After 0009 the definer RPC alone may mutate counters. Never restore
      -- broad 0008 grants to make this verifier pass.
      if has_table_privilege('service_role','public.'||v_table,'INSERT,UPDATE,DELETE,TRUNCATE') then
        raise exception 'Unsafe direct quota mutation after 0009: %',v_table;
      end if;
    elsif not has_table_privilege('service_role', 'public.' || v_table, 'INSERT')
        or not has_table_privilege('service_role', 'public.' || v_table, 'UPDATE')
        or not has_table_privilege('service_role', 'public.' || v_table, 'DELETE') then
      raise exception 'Missing service-role write access: %', v_table;
    end if;
  end loop;

  foreach v_column in array array['chat_id','payload','last_error','error','token','api_key'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name in ('v_deliveries_public','v_ingestion_health_public') and column_name = v_column) then
      raise exception 'Unsafe column in public operational view: %', v_column;
    end if;
  end loop;
end $$;

select '0008 schema/privilege checks passed (hosted Auth and behavior still require staging tests)' as result;
select relname, relrowsecurity from pg_class
  where oid in ('public.telegram_deliveries'::regclass,
                'public.twelvedata_browser_credit_budget'::regclass);
commit;
