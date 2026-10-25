-- Run with an administrative SQL connection. All temporary privileges are rolled back.
begin;
grant select,insert on public.financial_import_runs,public.financial_api_responses,public.financial_statement_entries to anon,authenticated;
do $$
declare role_name text; table_name text; n bigint;
begin
 foreach role_name in array array['anon','authenticated'] loop
  execute format('set local role %I', role_name);
  foreach table_name in array array['financial_import_runs','financial_api_responses','financial_statement_entries'] loop
   execute format('select count(*) from public.%I',table_name) into n;
   if n<>0 then raise exception 'RLS exposed rows to %',role_name; end if;
  end loop;
  begin
   insert into public.financial_import_runs(id,period_start,period_end,collector_version,status)
    values('00000000-0000-0000-0000-000000000000','2026-10-01T03:00:00Z','2026-10-02T03:00:00Z','RLS-test','running');
   raise exception 'RLS incorrectly allowed insert for %',role_name;
  exception when insufficient_privilege then null;
  end;
  reset role;
 end loop;
end $$;
rollback;
