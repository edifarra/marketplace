create or replace function public.enqueue_marketplace_activity_idempotently(
  p_marketplace text,
  p_event_type text,
  p_external_event_id text,
  p_order_id text,
  p_description text,
  p_status text,
  p_source_key text,
  p_raw_payload jsonb,
  p_processing_error text,
  p_next_attempt_at timestamptz,
  p_processed_at timestamptz
)
returns table(id uuid, status text, duplicated boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted_activity public.marketplace_activities%rowtype;
  existing_activity public.marketplace_activities%rowtype;
begin
  insert into public.marketplace_activities (
    marketplace,
    event_type,
    external_event_id,
    order_id,
    description,
    status,
    source_key,
    raw_payload,
    processing_error,
    next_attempt_at,
    processed_at
  ) values (
    p_marketplace,
    p_event_type,
    p_external_event_id,
    p_order_id,
    p_description,
    p_status,
    p_source_key,
    p_raw_payload,
    p_processing_error,
    p_next_attempt_at,
    p_processed_at
  )
  on conflict (marketplace, external_event_id)
    where external_event_id is not null
    do nothing
  returning * into inserted_activity;

  if inserted_activity.id is not null then
    return query select inserted_activity.id, inserted_activity.status, false;
    return;
  end if;

  select activity.*
    into existing_activity
    from public.marketplace_activities activity
   where activity.marketplace = p_marketplace
     and activity.external_event_id = p_external_event_id
   for update;

  if existing_activity.id is null then
    raise exception 'Evento duplicado nao localizado apos o conflito.';
  end if;

  if existing_activity.status in ('error', 'retry') and p_status = 'queued' then
    update public.marketplace_activities activity
       set status = 'queued',
           processing_error = null,
           next_attempt_at = p_next_attempt_at,
           processed_at = null
     where activity.id = existing_activity.id;
  end if;

  return query select existing_activity.id, existing_activity.status, true;
end;
$$;

revoke execute on function public.enqueue_marketplace_activity_idempotently(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;

grant execute on function public.enqueue_marketplace_activity_idempotently(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, timestamptz
) to service_role;
