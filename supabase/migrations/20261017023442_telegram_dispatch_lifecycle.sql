-- Reuse the existing job, URL and Vault secret. No new scheduler or HTTP call.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.sync_telegram_dispatch_cron()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_job bigint;
begin
  select jobid into target_job from cron.job
    where jobname = 'telegram-pending-dispatch';
  if target_job is null then
    raise exception 'Cron telegram-pending-dispatch ausente; restaurar migration 036 antes de salvar.';
  end if;
  perform cron.alter_job(target_job, active := (new.enabled and new.dispatch_enabled));
  return new;
end;
$$;

revoke all on function private.sync_telegram_dispatch_cron() from public, anon, authenticated, service_role;

create trigger sync_telegram_dispatch_cron
after update of enabled, dispatch_enabled on public.telegram_notification_config
for each row execute function private.sync_telegram_dispatch_cron();

-- Reconcile current state without touching credentials, options or notification history.
do $$
declare
  target_job bigint;
  should_run boolean;
begin
  select jobid into target_job from cron.job where jobname = 'telegram-pending-dispatch';
  if target_job is null then
    raise exception 'Cron telegram-pending-dispatch ausente; restaurar migration 036 antes de aplicar.';
  end if;
  select enabled and dispatch_enabled into strict should_run
    from public.telegram_notification_config where id = true;
  perform cron.alter_job(target_job, active := should_run);
end;
$$;

commit;
