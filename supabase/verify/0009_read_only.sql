-- Read-only. Confirm project identity first. This must NOT reserve a credit.
begin transaction read only;
select public.twelvedata_quota_status() as quota_contract;
select account,usage_day,daily_calls,cardinality(recent_calls) as rolling_reservations,
  blocked_until,updated_at from public.twelvedata_account_budget;
do $$
declare r text; t text; s jsonb;
begin
  s := public.twelvedata_quota_status();
  if s->>'guard_version'<>'1' or s->>'daily_limit'<>'700' or s->>'minute_limit'<>'6'
     or s->>'rolling_window_seconds'<>'61' or s->>'initialized'<>'true' then
    raise exception 'shared quota contract not ready';
  end if;
  foreach t in array array['twelvedata_account_budget','twelvedata_credit_budget','twelvedata_browser_credit_budget'] loop
    if not exists(select 1 from pg_class where oid=('public.'||t)::regclass and relrowsecurity) then
      raise exception 'quota RLS is disabled';
    end if;
    foreach r in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(r,'public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'quota table permits direct mutation';
      end if;
      if r<>'service_role' and has_table_privilege(r,'public.'||t,'SELECT') then
        raise exception 'quota table readable by public client';
      end if;
    end loop;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r,'public.reserve_twelvedata_account_credit(text,integer,integer,text,integer)','EXECUTE')
      or has_function_privilege(r,'public.reserve_twelvedata_credit(integer,integer)','EXECUTE')
      or has_function_privilege(r,'public.reserve_twelvedata_browser_credit(integer,integer,text,integer)','EXECUTE')
      or has_function_privilege(r,'public.twelvedata_quota_status()','EXECUTE') then
      raise exception 'quota RPC callable by public client';
    end if;
  end loop;
end $$;
-- Review these definitions against migration 0009; a version result alone is not
-- proof the actual installed code is intact or that ALL account clients use it.
select p.oid::regprocedure as function, p.prosecdef as security_definer, p.proconfig,
  pg_get_functiondef(p.oid) as definition
from pg_proc p where p.oid in (
 'public.reserve_twelvedata_account_credit(text,integer,integer,text,integer)'::regprocedure,
 'public.reserve_twelvedata_credit(integer,integer)'::regprocedure,
 'public.reserve_twelvedata_browser_credit(integer,integer,text,integer)'::regprocedure,
 'public.twelvedata_quota_status()'::regprocedure);
rollback;
