create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'telegram-pending-dispatch';
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end $$;

select cron.schedule(
  'telegram-pending-dispatch',
  '*/5 * * * *',
  $$select net.http_get(
    url := 'https://marketplace-ashen-five.vercel.app/api/telegram/dispatch-check',
    headers := jsonb_build_object(
      'x-supabase-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_dispatch_cron_secret' limit 1)
    ),
    timeout_milliseconds := 240000
  );$$
);

comment on table telegram_notification_jobs is
  'Controle persistente e idempotente das execuções disparadas pelo Supabase Cron.';
