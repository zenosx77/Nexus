-- Run only after confirming the project identity. No writes, quota reservations,
-- tokens, prediction payloads or user identifiers are returned.
begin transaction read only;
select current_database(), current_user;
-- History table may not exist for SQL-editor installations; check first.
select to_regclass('supabase_migrations.schema_migrations') as migration_history;
-- If present, separately run:
-- select version from supabase_migrations.schema_migrations order by version;
select tablename, rowsecurity from pg_tables
where schemaname='public' order by tablename;
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname in ('public','storage') order by tablename,policyname;
select conrelid::regclass as relation, conname, pg_get_constraintdef(oid) as definition
from pg_constraint where connamespace='public'::regnamespace order by 1,2;
select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by 1,2;
select id,name,public,file_size_limit,allowed_mime_types from storage.buckets where id='models';
select pair_code, max(ts) as newest_candle,
  extract(epoch from (now()-max(ts)-interval '1 minute'))::bigint as closed_candle_age_seconds
from public.market_candles group by pair_code order by pair_code;
select count(*) as duplicate_settlements from (
 select prediction_id from public.trade_outcomes group by prediction_id having count(*)>1
) d;
select outcome,is_valid,count(*) from public.trade_outcomes group by outcome,is_valid;
select count(*) as pending_over_90_minutes from public.predictions p
left join public.trade_outcomes o on o.prediction_id=p.id
where o.prediction_id is null and not p.is_shadow
and p.target_open_ts + make_interval(mins=>p.evaluation_horizon+90) < now();
select scope,usage_day,daily_calls,minute_bucket,minute_calls from public.twelvedata_credit_budget;
select scope,usage_day,daily_calls,minute_bucket,minute_calls from public.twelvedata_browser_credit_budget;
select status,is_deployed,count(*) from public.model_versions group by status,is_deployed;
rollback;
