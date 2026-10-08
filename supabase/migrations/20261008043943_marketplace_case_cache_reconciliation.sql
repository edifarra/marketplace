-- Local only. Existing incoming queue and case writer remain the business architecture.
create table public.marketplace_case_sync_control (
  case_id uuid primary key references public.marketplace_cases(id) on delete cascade,
  last_checked_at timestamptz,
  next_due_at timestamptz not null default now(),
  lease_owner uuid,
  lease_until timestamptz,
  business_hash text,
  case_revision bigint not null default 1,
  failures integer not null default 0,
  last_error text
);
create table public.marketplace_case_cache_revision (
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 1
);
insert into public.marketplace_case_cache_revision(singleton) values(true);
-- Existing index covers account/status scans poorly: only nonterminal identities are indexed.
create index marketplace_cases_reconciliation_open on public.marketplace_cases(marketplace_account_id,id)
  where (marketplace='mercado_livre' and case_type='claim' and status in ('open','opened','reopened'))
     or (marketplace='shopee' and case_type='return' and status in ('REQUESTED','PROCESSING','ACCEPTED','JUDGING','SELLER_DISPUTE'));
create index marketplace_case_sync_due on public.marketplace_case_sync_control(next_due_at,case_id);

create function public.case_business_date(v jsonb) returns jsonb
language plpgsql immutable security invoker set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(v)='string' and v#>>'{}' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*(Z|[+-][0-9]{2}:[0-9]{2})$' then
    begin return to_jsonb(to_char((v#>>'{}')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    exception when others then return v; end;
  end if;
  return v;
end $$;
create function public.case_business_canonical(v jsonb) returns jsonb
language plpgsql immutable security invoker set search_path=public,pg_temp as $$
declare r jsonb; s text;
begin
  if v is null or v='null'::jsonb then return 'null'::jsonb; end if;
  if jsonb_typeof(v)='object' then
    select coalesce(jsonb_object_agg(key,clean),'{}') into r from (
      select key,case when key in ('value','deadline','at','official_at','date_created','claim_created_at','return_created_at','message_date','sent_at')
        then case_business_date(case_business_canonical(value))
        else case_business_canonical(value) end clean from jsonb_each(v)
    ) q where clean<>'null'::jsonb;
    return r;
  elsif jsonb_typeof(v)='array' then
    select coalesce(jsonb_agg(case_business_canonical(value) order by ordinality),'[]') into r
      from jsonb_array_elements(v) with ordinality;
    return r;
  elsif jsonb_typeof(v)='string' then
    s:=v#>>'{}'; if s='' then return 'null'::jsonb; end if;
    return to_jsonb(s);
  end if;
  return v;
end $$;
create function public.case_business_set(v jsonb) returns jsonb
language sql immutable security invoker set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(clean order by clean::text),'[]') from
    (select case_business_canonical(value) clean from jsonb_array_elements(coalesce(v,'[]'))) q
$$;
create function public.case_observation_business(o jsonb) returns jsonb
language plpgsql immutable security invoker set search_path=public,pg_temp as $$
declare snapshot jsonb:=coalesce(o->'snapshot','{}')-'enrichment'; actions jsonb; deadlines jsonb; evidence jsonb;
begin
  select coalesce(jsonb_agg(value-array['observed_at','source','deadline_raw']),'[]') into actions from jsonb_array_elements(coalesce(o->'actions','[]'));
  select coalesce(jsonb_agg(case when value->>'precision' in ('date','timestamp') and value->>'value' is not null then value-array['source','raw_value'] else value-'source' end),'[]')
    into deadlines from jsonb_array_elements(coalesce(o->'deadlines','[]'));
  select coalesce(jsonb_agg(case when jsonb_typeof(value->'metadata')='object' then jsonb_set(value,'{metadata}',(value->'metadata')-array['source','observed_at']) else value end),'[]')
    into evidence from jsonb_array_elements(coalesce(o->'evidence','[]'));
  if jsonb_typeof(snapshot->'current_claim')='object' then snapshot:=jsonb_set(snapshot,'{current_claim}',(snapshot->'current_claim')-array['last_updated','date_last_updated']); end if;
  if snapshot ? 'current_actions' then snapshot:=jsonb_set(snapshot,'{current_actions}',case_business_set(actions)); end if;
  return case_business_canonical(jsonb_build_object('snapshot',snapshot,'deadlines',case_business_set(deadlines),
    'actions',case_business_set(actions),'evidence',case_business_set(evidence),
    'claim_messages',case_business_set(o->'claim_messages'),'claim_events',case_business_set(o->'claim_events')));
end
$$;
create function public.case_observation_fingerprint(o jsonb) returns text
language sql immutable security invoker set search_path=public,pg_temp as $$
  select encode(sha256(convert_to(case_observation_business(o)::text,'UTF8')),'hex')
$$;

-- Compare under the same row lock as the business writer. Processing timestamps never count.
alter function public.persist_marketplace_case(jsonb) rename to persist_marketplace_case_before_cache;
create function public.persist_marketplace_case(p_observation jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare c marketplace_cases; old_hash text; new_hash text:=case_observation_fingerprint(p_observation); previous marketplace_case_observations; baseline jsonb; result uuid; item jsonb; fresh_evidence jsonb:='[]'; prior_batch text;
begin
  select * into c from marketplace_cases where marketplace=p_observation->>'marketplace'
    and marketplace_account_id=(p_observation->>'marketplace_account_id')::uuid and case_type=p_observation->>'case_type'
    and external_case_id=p_observation->>'external_case_id' for update;
  if c.id is not null and p_observation->>'source' in ('ml:claim_detail','shopee:return_detail') then
    -- Stale details cannot become a new comparison baseline or overwrite the projection.
    if (p_observation->>'official_at')::timestamptz < c.official_updated_at
       or (p_observation->>'order_at')::timestamptz < c.snapshot_order_at then return c.id; end if;
    select business_hash into old_hash from marketplace_case_sync_control where case_id=c.id;
    if old_hash is null then
      -- Bootstrap from the last actual detail, not an identity-only/push observation.
      select * into previous from marketplace_case_observations where case_id=c.id
        and source in ('ml:claim_detail','shopee:return_detail') order by order_at desc,observed_at desc limit 1;
      if previous.id is not null then
        select jsonb_build_object('snapshot',previous.snapshot,
          'deadlines',coalesce((select jsonb_agg(metadata) from marketplace_case_deadlines where observation_id=previous.id),'[]'),
          'actions',coalesce((select jsonb_agg(jsonb_build_object('code',action_code,'mandatory',mandatory,'deadline',deadline,'parameters',capabilities)) from marketplace_case_actions where observation_id=previous.id),'[]'),
          'evidence',coalesce((select jsonb_agg(jsonb_build_object('media_type',media_type,'reference',reference,'metadata',metadata)) from marketplace_case_evidence where observation_id=previous.id),'[]'),
          'claim_messages',coalesce((select jsonb_agg(jsonb_build_object('key',external_message_id,'direction',direction,'text',text,'sender_role',raw_data->>'sender_role','at',sent_at,'raw',raw_data)) from marketplace_conversation_messages where conversation_id=c.conversation_id and c.marketplace='mercado_livre'),'[]'),
          'claim_events',coalesce((select jsonb_agg(jsonb_build_object('key',transition_key,'event_type',event_type,'state',state,'actor',actor,'official_at',official_at,'source',source)) from marketplace_case_timeline where case_id=c.id and event_type<>'state_observed' and c.marketplace='mercado_livre'),'[]')) into baseline;
        old_hash:=case_observation_fingerprint(baseline);
      end if;
    end if;
    if new_hash is not distinct from old_hash then
      insert into marketplace_case_sync_control(case_id,business_hash) values(c.id,new_hash)
        on conflict(case_id) do update set business_hash=excluded.business_hash where marketplace_case_sync_control.business_hash is null;
      return c.id;
    end if;
  end if;
  if c.id is not null and p_observation->>'source'='persisted_event' and exists(select 1 from marketplace_case_sync_control where case_id=c.id and business_hash is not null) then
    p_observation:=p_observation||'{"identity_only":true}'::jsonb;
  end if;
  if c.id is not null and p_observation->>'source' in ('ml:claim_detail','shopee:return_detail') then
    for item in select value from jsonb_array_elements(coalesce(p_observation->'evidence','[]')) loop
      if exists(select 1 from marketplace_case_evidence where case_id=c.id and media_type=item->>'media_type' and reference=item->>'reference') then
        update marketplace_case_evidence set metadata=item->'metadata' where case_id=c.id and media_type=item->>'media_type' and reference=item->>'reference'
          and case_business_canonical(metadata-array['source','observed_at']) is distinct from case_business_canonical((item->'metadata')-array['source','observed_at']);
      else fresh_evidence:=fresh_evidence||jsonb_build_array(item); end if;
    end loop;
    p_observation:=jsonb_set(p_observation,'{evidence}',fresh_evidence);
  end if;
  prior_batch:=current_setting('app.case_revision_batch',true);
  if p_observation->>'source' in ('ml:claim_detail','shopee:return_detail') then perform set_config('app.case_revision_batch','1',true); end if;
  result:=persist_marketplace_case_before_cache(p_observation);
  perform set_config('app.case_revision_batch',coalesce(prior_batch,''),true);
  if p_observation->>'source' in ('ml:claim_detail','shopee:return_detail') then
    insert into marketplace_case_sync_control(case_id,business_hash) values(result,new_hash)
      on conflict(case_id) do update set business_hash=excluded.business_hash
      where marketplace_case_sync_control.business_hash is distinct from excluded.business_hash;
    -- Deadlines/evidence can change without changing the case's scalar projection.
    update marketplace_case_sync_control set case_revision=case_revision+1 where case_id=result;
    update marketplace_case_cache_revision set revision=revision+1 where singleton;
  end if;
  return result;
end $$;

create function public.bump_marketplace_case_cache_revision() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare target uuid; related uuid;
begin
  if current_setting('app.case_revision_batch',true)='1' then
    if TG_OP='DELETE' then return old; end if; return new;
  end if;
  if TG_TABLE_NAME='outgoing_marketplace_activities' then
    if coalesce(new.activity_type,old.activity_type)<>'claim_action' then
      if TG_OP='DELETE' then return old; end if; return new;
    end if;
  end if;
  if TG_OP='UPDATE' and to_jsonb(new)-array['updated_at','enrichment','snapshot_order_at'] = to_jsonb(old)-array['updated_at','enrichment','snapshot_order_at'] then return new; end if;
  if TG_TABLE_NAME='marketplace_conversation_messages' then
    related:=coalesce(new.conversation_id,old.conversation_id);
    if not exists(select 1 from marketplace_cases where conversation_id=related) then
      if TG_OP='DELETE' then return old; end if; return new;
    end if;
    update marketplace_case_sync_control set case_revision=case_revision+1 where case_id in(select id from marketplace_cases where conversation_id=related);
  elsif TG_TABLE_NAME='marketplace_cases' and TG_OP<>'DELETE' then
    target:=new.id;
    insert into marketplace_case_sync_control(case_id) values(target) on conflict do nothing;
    update marketplace_case_sync_control set case_revision=case_revision+1 where case_id=target;
  elsif TG_TABLE_NAME='outgoing_marketplace_activities' then
    target:=coalesce(new.source_id,old.source_id)::uuid;
    update marketplace_case_sync_control set case_revision=case_revision+1 where case_id=target;
  end if;
  update marketplace_case_cache_revision set revision=revision+1 where singleton;
  if TG_OP='DELETE' then return old; end if; return new;
end $$;
create trigger marketplace_case_cache_case after insert or update or delete on public.marketplace_cases for each row execute function public.bump_marketplace_case_cache_revision();
create trigger marketplace_case_cache_message after insert or update or delete on public.marketplace_conversation_messages for each row execute function public.bump_marketplace_case_cache_revision();
create trigger marketplace_case_cache_operation after insert or update or delete on public.outgoing_marketplace_activities for each row execute function public.bump_marketplace_case_cache_revision();

create function public.begin_marketplace_case_refresh(p_case_id uuid,p_owner uuid) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  insert into marketplace_case_sync_control(case_id) values(p_case_id) on conflict do nothing;
  update marketplace_case_sync_control set lease_owner=p_owner,lease_until=now()+interval '10 minutes'
    where case_id=p_case_id and (lease_until is null or lease_until<now());
  return found;
end $$;
create function public.finish_marketplace_case_refresh(p_case_id uuid,p_owner uuid,p_success boolean) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update marketplace_case_sync_control set lease_owner=null,lease_until=null,
    last_checked_at=case when p_success then now() else last_checked_at end,
    next_due_at=case when p_success is null then next_due_at else now()+interval '60 minutes' end,
    failures=case when p_success then 0 when p_success=false then failures+1 else failures end,
    last_error=case when p_success then null when p_success=false then 'case_refresh_failed' else last_error end
    where case_id=p_case_id and lease_owner=p_owner;
  return found;
end $$;
create function public.marketplace_case_has_pending_event(p_case_id uuid) returns boolean
language sql stable security invoker set search_path=public,pg_temp as $$
  select exists(select 1 from marketplace_cases mc join config_marketplace_accounts a on a.id=mc.marketplace_account_id
    join marketplace_activities q on q.marketplace=mc.marketplace and q.status in ('queued','retry','processing')
    where mc.id=p_case_id and (
      (mc.marketplace='shopee' and q.event_type='29'
        and coalesce(q.raw_payload->'notification',q.raw_payload)->'data'->>'return_sn'=mc.external_case_id
        and coalesce(coalesce(q.raw_payload->'notification',q.raw_payload)->>'shop_id',coalesce(q.raw_payload->'notification',q.raw_payload)->'data'->>'shop_id')=coalesce(a.shop_id::text,a.account_id::text)) or
      (mc.marketplace='mercado_livre' and q.event_type='post_purchase'
        and coalesce(coalesce(q.raw_payload->'notification',q.raw_payload)->>'claim_id',substring(coalesce(q.raw_payload->'notification',q.raw_payload)->>'resource' from '/claims/([0-9]+)'))=mc.external_case_id
        and coalesce(q.raw_payload->'notification',q.raw_payload)->>'user_id'=coalesce(a.seller_id::text,a.account_id::text))))
$$;
-- Keep safety jobs behind actual notifications; retain the existing queue claim/retry semantics.
create or replace function public.claim_marketplace_activity_queue(p_limit integer default 10)
returns setof public.marketplace_activities language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  return query with candidates as (
    select id from marketplace_activities where (status in ('queued','retry') and next_attempt_at<=now())
      or (status='processing' and locked_at<now()-interval '10 minutes')
    order by (event_type='case_reconcile') nulls first,received_at,id for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  ) update marketplace_activities a set status='processing',attempt_count=a.attempt_count+1,
    processing_started_at=now(),locked_at=now(),processing_error=null from candidates where a.id=candidates.id returning a.*;
end $$;
-- Lightweight safety reads. These RPCs never mutate case business data: changed
-- observations and failed reads are handed to the existing queue atomically.
create function public.claim_marketplace_case_checks(p_owner uuid,p_limit integer default 20) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare c record; acquired uuid; results jsonb:='[]';
begin
  for c in select mc.id,mc.marketplace,mc.marketplace_account_id,mc.external_case_id,mc.order_id,mc.case_type,to_jsonb(a) account
    from marketplace_cases mc join config_marketplace_accounts a on a.id=mc.marketplace_account_id
    left join marketplace_case_sync_control s on s.case_id=mc.id
    where a.active and ((mc.marketplace='mercado_livre' and mc.case_type='claim' and mc.status in ('open','opened','reopened'))
      or (mc.marketplace='shopee' and mc.case_type='return' and mc.status in ('REQUESTED','PROCESSING','ACCEPTED','JUDGING','SELLER_DISPUTE')))
    and (s.next_due_at is null or s.next_due_at<=now()) and (s.lease_until is null or s.lease_until<now())
    and not exists(select 1 from marketplace_activities q where q.source_key='case_reconcile:'||mc.id::text and q.status in ('queued','retry','processing'))
    and not marketplace_case_has_pending_event(mc.id)
    order by coalesce(s.next_due_at,'-infinity'),mc.id limit greatest(1,least(p_limit,20)) for update of mc skip locked
  loop
    acquired:=null;
    insert into marketplace_case_sync_control(case_id,lease_owner,lease_until) values(c.id,p_owner,now()+interval '10 minutes')
      on conflict(case_id) do update set lease_owner=excluded.lease_owner,lease_until=excluded.lease_until
      where marketplace_case_sync_control.lease_until is null or marketplace_case_sync_control.lease_until<now()
      returning case_id into acquired;
    if acquired is not null then results:=results||jsonb_build_array(to_jsonb(c)); end if;
  end loop;
  return results;
end $$;
create function public.finish_marketplace_case_checks(p_owner uuid,p_results jsonb) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare r jsonb; c marketplace_cases; s marketplace_case_sync_control; hash text; job jsonb; checked integer:=0; queued integer:=0;
begin
  if jsonb_array_length(p_results)>5 then raise exception 'case_check_batch_too_large'; end if;
  for r in select value from jsonb_array_elements(p_results) loop
    select * into s from marketplace_case_sync_control where case_id=(r->>'case_id')::uuid for update;
    if s.lease_owner is distinct from p_owner or s.lease_until<now() then continue; end if;
    select * into strict c from marketplace_cases where id=s.case_id;
    hash:=null;
    if r ? 'observation' then
      job:=r->'observation';
      if job->>'marketplace' is distinct from c.marketplace or (job->>'marketplace_account_id')::uuid is distinct from c.marketplace_account_id
        or job->>'external_case_id' is distinct from c.external_case_id or job->>'case_type' is distinct from c.case_type then raise exception 'case_check_identity_mismatch'; end if;
      hash:=case_observation_fingerprint(job);
      if (job->>'official_at')::timestamptz<c.official_updated_at or (job->>'order_at')::timestamptz<c.snapshot_order_at then hash:=s.business_hash; end if;
    end if;
    if hash is distinct from s.business_hash or r ? 'error' then
      perform enqueue_marketplace_activity_idempotently(c.marketplace,'case_reconcile',
        'case_check:'||c.id::text||':'||p_owner::text||':'||coalesce(hash,'error'),c.order_id,'Atualização detectada pela reconciliação',
        'queued','case_reconcile:'||c.id::text,
        jsonb_strip_nulls(jsonb_build_object('case_reconcile_id',c.id,'account_id',c.marketplace_account_id,'case_observation',r->'observation')),
        null,now(),null);
      queued:=queued+1;
    end if;
    update marketplace_case_sync_control set lease_owner=null,lease_until=null,
      last_checked_at=case when r ? 'observation' then now() else last_checked_at end,
      next_due_at=now()+interval '60 minutes',
      failures=case when r ? 'error' then failures+1 else 0 end,
      last_error=case when r ? 'error' then 'case_check_failed' else null end where case_id=c.id;
    checked:=checked+1;
  end loop;
  return jsonb_build_object('checked',checked,'queued',queued);
end $$;
do $$ declare t text; f record; begin
  foreach t in array array['marketplace_case_sync_control','marketplace_case_cache_revision'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
  end loop;
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('case_business_date','case_business_canonical','case_business_set','case_observation_business','case_observation_fingerprint','persist_marketplace_case_before_cache','persist_marketplace_case','bump_marketplace_case_cache_revision','claim_marketplace_case_checks','finish_marketplace_case_checks',
     'begin_marketplace_case_refresh','finish_marketplace_case_refresh','marketplace_case_has_pending_event','claim_marketplace_activity_queue') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
