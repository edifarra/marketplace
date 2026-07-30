alter table marketplace_activities
  add column if not exists source_key text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists processing_started_at timestamptz,
  add column if not exists locked_at timestamptz;

create index if not exists idx_marketplace_activities_queue
  on marketplace_activities(status, next_attempt_at, received_at)
  where status in ('queued', 'retry', 'processing');

create or replace function claim_marketplace_activity_queue(p_limit integer default 10)
returns setof marketplace_activities
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from marketplace_activities
    where (
      status in ('queued', 'retry')
      and next_attempt_at <= now()
    ) or (
      status = 'processing'
      and locked_at < now() - interval '10 minutes'
    )
    order by received_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update marketplace_activities activity
  set
    status = 'processing',
    attempt_count = activity.attempt_count + 1,
    processing_started_at = now(),
    locked_at = now(),
    processing_error = null
  from candidates
  where activity.id = candidates.id
  returning activity.*;
end;
$$;

