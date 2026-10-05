-- Stage 1: independent business persistence. No external requests or queue replay.
create table public.marketplace_case_rollout (
  singleton boolean primary key default true check (singleton),
  enrichment_starts_at timestamptz not null default now()
);
insert into public.marketplace_case_rollout(singleton) values (true);

create table public.marketplace_cases (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null check (marketplace in ('mercado_livre','shopee')),
  marketplace_account_id uuid not null references public.config_marketplace_accounts(id) on delete restrict,
  case_type text not null check (case_type in ('claim','return')),
  external_case_id text not null check (external_case_id <> ''),
  venda_id uuid references public.venda(id) on delete set null,
  conversation_id uuid references public.marketplace_conversations(id) on delete set null,
  venda_item_id uuid references public.venda_item(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  listing_id text,
  order_id text,
  status text,
  stage text,
  responsible text not null default 'unknown' check (responsible in ('buyer','seller','marketplace','unknown')),
  needs_action boolean,
  reputation_impact text not null default 'unknown' check (reputation_impact in ('affected','not_affected','unknown')),
  resolution jsonb,
  content jsonb not null default '{}',
  reverse_logistics jsonb not null default '{}',
  enrichment jsonb not null default '{"state":"incomplete"}',
  official_updated_at timestamptz,
  snapshot_order_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(marketplace,marketplace_account_id,external_case_id,case_type)
);
create index marketplace_cases_sale on public.marketplace_cases(venda_id);
create table public.marketplace_case_observations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.marketplace_cases(id) on delete cascade,
  source_key text not null,
  source text not null,
  official_at timestamptz,
  observed_at timestamptz not null,
  order_at timestamptz not null,
  state jsonb not null,
  snapshot jsonb not null,
  unique(case_id,source_key)
);
create table public.marketplace_case_timeline (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.marketplace_cases(id) on delete cascade,
  transition_key text not null,
  event_type text not null,
  state jsonb not null,
  actor text not null default 'unknown',
  official_at timestamptz,
  observed_at timestamptz not null,
  source text not null,
  unique(case_id,transition_key)
);
create index marketplace_case_observations_order on public.marketplace_case_observations(case_id,order_at desc,observed_at desc);
create index marketplace_case_timeline_order on public.marketplace_case_timeline(case_id,official_at,observed_at);
-- Snapshot children preserve previous observations; no technical-activity FK.
create table public.marketplace_case_deadlines (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.marketplace_cases(id) on delete cascade,
  observation_id uuid not null references public.marketplace_case_observations(id) on delete cascade,
  ordinal integer not null,
  purpose text not null,
  responsible text not null,
  value text,
  precision text not null check (precision in ('date','timestamp','unknown')),
  timezone text,
  source text not null,
  validity text not null,
  metadata jsonb not null,
  unique(observation_id,ordinal)
);
create table public.marketplace_case_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.marketplace_cases(id) on delete cascade,
  observation_id uuid not null references public.marketplace_case_observations(id) on delete cascade,
  ordinal integer not null,
  action_code text not null,
  mandatory boolean,
  deadline timestamptz,
  observed_at timestamptz not null,
  capabilities jsonb not null default '{}',
  unique(observation_id,ordinal)
);
create table public.marketplace_case_evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.marketplace_cases(id) on delete cascade,
  observation_id uuid not null references public.marketplace_case_observations(id) on delete cascade,
  ordinal integer not null,
  media_type text not null check(media_type in ('image','video','attachment')),
  reference text not null,
  metadata jsonb not null default '{}',
  unique(observation_id,ordinal)
);

create function public.persist_marketplace_case(p_observation jsonb) returns uuid
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  o jsonb := p_observation; s jsonb := o->'snapshot';
  c public.marketplace_cases; obs uuid; item jsonb; n integer;
  st jsonb := o->'state'; old_st jsonb; previous public.marketplace_case_observations;
  ordering timestamptz := (o->>'order_at')::timestamptz;
  transition text; safe_sale uuid; safe_chat uuid;
begin
  insert into public.marketplace_cases(marketplace,marketplace_account_id,case_type,external_case_id)
  values(o->>'marketplace',(o->>'marketplace_account_id')::uuid,o->>'case_type',o->>'external_case_id')
  on conflict(marketplace,marketplace_account_id,external_case_id,case_type) do nothing;
  select * into strict c from public.marketplace_cases
  where marketplace=o->>'marketplace' and marketplace_account_id=(o->>'marketplace_account_id')::uuid
    and case_type=o->>'case_type' and external_case_id=o->>'external_case_id' for update;
  -- Link identity-only saved mediations even when a newer detail already exists.
  -- A conflicting order reference never reassigns a case or its Chat.
  if s->>'order_id' is not null and (c.order_id is null or c.order_id=s->>'order_id') then
    select id into safe_sale from public.venda where marketplace=c.marketplace and order_id=s->>'order_id'
      and raw_data->>'marketplace_account_id'=c.marketplace_account_id::text;
    select min(id::text)::uuid into safe_chat from public.marketplace_conversations
      where marketplace=c.marketplace and marketplace_account_id=c.marketplace_account_id
        and order_id=s->>'order_id' and conversation_type in ('chat','post_sale') having count(*)=1;
    update public.marketplace_cases set order_id=coalesce(order_id,s->>'order_id'),
      venda_id=coalesce(safe_sale,venda_id), conversation_id=coalesce(safe_chat,conversation_id) where id=c.id;
  end if;
  if exists(select 1 from public.marketplace_case_observations where case_id=c.id and source_key=o->>'source_key') then
    return c.id;
  end if;
  select * into previous from public.marketplace_case_observations where case_id=c.id
    and order_at <= ordering
    order by order_at desc, observed_at desc limit 1;
  old_st := previous.state;
  st := coalesce(old_st,'{"status":null,"stage":null,"responsible":"unknown","logistics_status":null,"resolution":null}'::jsonb)
    || jsonb_strip_nulls(st - 'responsible')
    || case when st->>'responsible' <> 'unknown' then jsonb_build_object('responsible',st->>'responsible') else '{}'::jsonb end;
  insert into public.marketplace_case_observations(case_id,source_key,source,official_at,observed_at,order_at,state,snapshot)
  values(c.id,o->>'source_key',o->>'source',(o->>'official_at')::timestamptz,(o->>'observed_at')::timestamptz,ordering,st,s)
  returning id into obs;
  if st is distinct from old_st and st <> '{"status":null,"stage":null,"responsible":"unknown","logistics_status":null,"resolution":null}'::jsonb then
    -- Adjacent equal states are observations, not new visual steps. Official transitions dedupe across deliveries.
    transition := md5(st::text || coalesce(o->>'official_at',o->>'source_key'));
    insert into public.marketplace_case_timeline(case_id,transition_key,event_type,state,actor,official_at,observed_at,source)
    values(c.id,transition,'state_observed',st,'unknown',(o->>'official_at')::timestamptz,(o->>'observed_at')::timestamptz,o->>'source')
    on conflict(case_id,transition_key) do nothing;
  end if;
  if (not coalesce((o->>'identity_only')::boolean,false) or c.snapshot_order_at is null)
     and (c.snapshot_order_at is null or ordering >= c.snapshot_order_at)
     and (o->>'official_at' is null or c.official_updated_at is null or (o->>'official_at')::timestamptz >= c.official_updated_at) then
    update public.marketplace_cases set
      status=coalesce(s->>'status',status),stage=coalesce(s->>'stage',stage),
      responsible=coalesce(s->>'responsible','unknown'),needs_action=(s->>'needs_action')::boolean,
      reputation_impact=case when c.marketplace='shopee' then 'unknown' else coalesce(s->>'reputation_impact','unknown') end,
      resolution=coalesce(nullif(s->'resolution','null'::jsonb),resolution),
      content=content || jsonb_strip_nulls(s - array['order_id','status','stage','responsible','needs_action','reputation_impact','resolution','reverse_logistics','enrichment']),
      reverse_logistics=reverse_logistics || jsonb_strip_nulls(s->'reverse_logistics'),
      enrichment=s->'enrichment',official_updated_at=coalesce((o->>'official_at')::timestamptz,official_updated_at),
      snapshot_order_at=ordering,updated_at=now() where id=c.id;
  end if;
  n:=0;
  for item in select value from jsonb_array_elements(coalesce(o->'deadlines','[]')) loop
    n:=n+1;
    insert into public.marketplace_case_deadlines(case_id,observation_id,ordinal,purpose,responsible,value,precision,timezone,source,validity,metadata)
    values(c.id,obs,n,item->>'purpose',item->>'responsible',item->>'value',item->>'precision',item->>'timezone',item->>'source',item->>'validity',item);
  end loop;
  n:=0;
  for item in select value from jsonb_array_elements(coalesce(o->'actions','[]')) loop
    n:=n+1;
    insert into public.marketplace_case_actions(case_id,observation_id,ordinal,action_code,mandatory,deadline,observed_at,capabilities)
    values(c.id,obs,n,item->>'code',(item->>'mandatory')::boolean,(item->>'deadline')::timestamptz,(item->>'observed_at')::timestamptz,item->'parameters');
  end loop;
  n:=0;
  for item in select value from jsonb_array_elements(coalesce(o->'evidence','[]')) loop
    n:=n+1;
    insert into public.marketplace_case_evidence(case_id,observation_id,ordinal,media_type,reference,metadata)
    values(c.id,obs,n,item->>'media_type',item->>'reference',item->'metadata');
  end loop;
  return c.id;
end $$;
revoke all on function public.persist_marketplace_case(jsonb) from public,anon,authenticated;
grant execute on function public.persist_marketplace_case(jsonb) to service_role;
do $$ declare t text; begin
  foreach t in array array['marketplace_case_rollout','marketplace_cases','marketplace_case_observations',
    'marketplace_case_timeline','marketplace_case_deadlines','marketplace_case_actions','marketplace_case_evidence'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update,delete on table public.%I to service_role',t);
  end loop;
end $$;
