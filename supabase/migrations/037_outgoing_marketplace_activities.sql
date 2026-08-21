create table if not exists outgoing_marketplace_activities (
  id uuid primary key default gen_random_uuid(),
  destination text not null check (destination in ('mercado_livre','shopee','tiny')),
  activity_type text not null check (activity_type in ('stock_update','listing_create','listing_update','listing_delete')),
  product_id uuid references products(id) on delete set null,
  sku text not null,
  product_name text,
  marketplace_account_id uuid references config_marketplace_accounts(id) on delete set null,
  listing_id text,
  status text not null default 'queued' check (status in ('queued','processing','retry','completed','error')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  queue_position bigint generated always as identity,
  previous_data jsonb not null default '{}',
  requested_data jsonb not null default '{}',
  confirmed_data jsonb,
  processing_error text,
  source_type text,
  source_id text,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_outgoing_activities_queue
  on outgoing_marketplace_activities(status, next_attempt_at, queue_position)
  where status in ('queued','retry','processing');
create index if not exists idx_outgoing_activities_created
  on outgoing_marketplace_activities(created_at desc);
create index if not exists idx_outgoing_activities_filters
  on outgoing_marketplace_activities(activity_type, marketplace_account_id, created_at desc);
create unique index if not exists idx_outgoing_pending_stock
  on outgoing_marketplace_activities(destination, marketplace_account_id, listing_id, activity_type)
  where activity_type = 'stock_update' and status in ('queued','processing','retry');

create table if not exists outgoing_marketplace_activity_history (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references outgoing_marketplace_activities(id) on delete cascade,
  attempt integer not null default 0,
  stage text not null,
  status text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_outgoing_activity_history_activity
  on outgoing_marketplace_activity_history(activity_id, created_at);

create or replace function claim_outgoing_marketplace_activity_queue(p_limit integer default 10)
returns setof outgoing_marketplace_activities
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select id from outgoing_marketplace_activities
    where (status in ('queued','retry') and next_attempt_at <= now())
       or (status = 'processing' and processing_started_at < now() - interval '10 minutes')
    order by queue_position
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update outgoing_marketplace_activities activity set
    status = 'processing', attempt_count = activity.attempt_count + 1,
    processing_started_at = now(), processing_error = null, updated_at = now()
  from candidates where activity.id = candidates.id returning activity.*;
end; $$;

create or replace function requeue_outgoing_marketplace_activity(p_id uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_attempts integer;
begin
  select attempt_count into v_attempts from outgoing_marketplace_activities where id = p_id for update;
  update outgoing_marketplace_activities set
    status = case when v_attempts >= 5 then 'error' else 'retry' end,
    processing_error = p_error,
    processed_at = case when v_attempts >= 5 then now() else null end,
    next_attempt_at = now(),
    queue_position = default,
    processing_started_at = null,
    updated_at = now()
  where id = p_id;
end; $$;
