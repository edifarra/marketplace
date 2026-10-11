-- Keep the original one-argument RPC intact for workers running the previous release.
-- Photo checks share the existing claim call; they never enter the PUT retry queue.
alter table public.outgoing_marketplace_activities
  add column photo_confirmation jsonb,
  add column photo_next_at timestamptz,
  add column photo_lease_at timestamptz;

create index outgoing_ml_photo_due on public.outgoing_marketplace_activities(photo_next_at, queue_position)
  where status = 'completed' and destination = 'mercado_livre'
    and activity_type = 'listing_update' and photo_next_at is not null;

create function public.claim_outgoing_marketplace_activity_queue(p_limit integer, p_include_photos boolean)
returns setof public.outgoing_marketplace_activities
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select id from outgoing_marketplace_activities
    where (status in ('queued','retry') and next_attempt_at <= now())
       or (status = 'processing' and processing_started_at < now() - interval '10 minutes')
       or (p_include_photos and status = 'completed' and destination = 'mercado_livre'
         and activity_type = 'listing_update' and photo_next_at <= now()
         and (photo_lease_at is null or photo_lease_at < now() - interval '10 minutes'))
    order by queue_position
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
  update outgoing_marketplace_activities activity set
    status = case when activity.status = 'completed' then activity.status else 'processing' end,
    attempt_count = activity.attempt_count + case when activity.status = 'completed' then 0 else 1 end,
    processing_started_at = case when activity.status = 'completed' then activity.processing_started_at else now() end,
    processing_error = case when activity.status = 'completed' then activity.processing_error else null end,
    photo_lease_at = case when activity.status = 'completed' then now() else activity.photo_lease_at end,
    updated_at = now()
  from candidates where activity.id = candidates.id returning activity.*
  )
  select (jsonb_populate_record(null::public.outgoing_marketplace_activities,
    to_jsonb(claimed) || case when claimed.status = 'completed'
      then '{"requested_data":{},"previous_data":{}}'::jsonb else '{}'::jsonb end)).*
  from claimed;
end; $$;

revoke all on function public.claim_outgoing_marketplace_activity_queue(integer, boolean) from public, anon, authenticated;
grant execute on function public.claim_outgoing_marketplace_activity_queue(integer, boolean) to service_role;
