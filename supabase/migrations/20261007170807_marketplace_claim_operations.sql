-- Existing incoming/outgoing queues and existing case/conversation tables only.
alter table public.marketplace_cases drop constraint marketplace_cases_reputation_impact_check;
alter table public.marketplace_cases add constraint marketplace_cases_reputation_impact_check
  check(reputation_impact in ('affected','not_affected','not_applies','unknown'));
alter table public.marketplace_conversations drop constraint marketplace_conversations_conversation_type_check;
alter table public.marketplace_conversations add constraint marketplace_conversations_conversation_type_check
  check(conversation_type in ('question','chat','post_sale','claim'));
alter table public.outgoing_marketplace_activities drop constraint outgoing_marketplace_activities_activity_type_check;
alter table public.outgoing_marketplace_activities add constraint outgoing_marketplace_activities_activity_type_check
  check(activity_type in ('stock_update','listing_create','listing_update','listing_delete','answer_send','question_answer','conversation_read','conversation_delete','claim_action'));
alter table public.outgoing_marketplace_activities add column remote_execution_state text not null default 'not_started'
  check(remote_execution_state in ('not_started','sending','uncertain','succeeded','confirmed','rejected'));
create unique index outgoing_claim_equivalent on public.outgoing_marketplace_activities
  (marketplace_account_id,source_id,(requested_data->>'fingerprint')) where activity_type='claim_action' and remote_execution_state<>'rejected';
create unique index outgoing_claim_one_active on public.outgoing_marketplace_activities(marketplace_account_id,source_id)
  where activity_type='claim_action' and (status in ('queued','processing','retry') or remote_execution_state in ('sending','uncertain','succeeded'));
create index outgoing_claim_confirmation on public.outgoing_marketplace_activities(updated_at,id)
  where activity_type='claim_action' and remote_execution_state in ('sending','uncertain','succeeded');
create index marketplace_claim_buyer on public.marketplace_cases(marketplace_account_id,(content->'buyer_data'->>'id')) where marketplace='mercado_livre';

create function public.enqueue_marketplace_claim_operation(p_case_id uuid,p_operation_id uuid,p_request jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare c marketplace_cases; existing outgoing_marketplace_activities; operation uuid;
begin
  select * into strict c from marketplace_cases where id=p_case_id and marketplace='mercado_livre' and case_type='claim' for update;
  if p_request->>'action' not in ('refund','allow_partial_refund','allow_return','send_message_to_complainant') then raise exception 'claim_action_invalid'; end if;
  if p_request->>'operatorId' is null or p_request->>'fingerprint' is null then raise exception 'claim_operation_invalid'; end if;
  select * into existing from outgoing_marketplace_activities where id=p_operation_id;
  if found then
    if existing.source_id<>c.id::text or existing.marketplace_account_id<>c.marketplace_account_id or existing.activity_type<>'claim_action'
      or existing.requested_data->>'operatorId'<>p_request->>'operatorId' or existing.requested_data->'parameters' is distinct from p_request->'parameters'
      or existing.requested_data->>'action'<>p_request->>'action' then raise exception 'claim_operation_conflict'; end if;
    return existing.id;
  end if;
  select * into existing from outgoing_marketplace_activities where activity_type='claim_action' and marketplace_account_id=c.marketplace_account_id
    and source_id=c.id::text and requested_data->>'fingerprint'=p_request->>'fingerprint' and remote_execution_state<>'rejected';
  if found then return existing.id; end if;
  insert into outgoing_marketplace_activities(id,destination,activity_type,marketplace_account_id,sku,product_name,source_type,source_id,requested_data)
    values(p_operation_id,'mercado_livre','claim_action',c.marketplace_account_id,c.external_case_id,'Reclamação #'||c.external_case_id,'marketplace_case',c.id::text,p_request) returning id into operation;
  insert into outgoing_marketplace_activity_history(activity_id,attempt,stage,status,details)
    values(operation,0,'claim_queued','queued',p_request - 'baseline');
  return operation;
end $$;
create function public.begin_marketplace_claim_send(p_operation_id uuid) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update outgoing_marketplace_activities set remote_execution_state='sending',updated_at=now()
    where id=p_operation_id and activity_type='claim_action' and status='processing' and remote_execution_state='not_started';
  return found;
end $$;

alter function public.persist_marketplace_case(jsonb) rename to persist_marketplace_case_base;
create function public.persist_marketplace_case(p_observation jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_case_id uuid; c marketplace_cases; conversation uuid; m jsonb; e jsonb; buyer jsonb;
begin
  v_case_id:=persist_marketplace_case_base(p_observation);
  select * into strict c from marketplace_cases where id=v_case_id for update;
  if c.marketplace<>'mercado_livre' or c.case_type<>'claim' or not (p_observation ? 'claim_messages') then return v_case_id; end if;
  -- An out-of-order refresh cannot regress the current official projection or conversation.
  if (p_observation->>'official_at')::timestamptz is distinct from c.official_updated_at then return v_case_id; end if;
  buyer:=c.content->'buyer_data';
  insert into marketplace_conversations(marketplace,marketplace_account_id,external_conversation_id,conversation_type,order_id,buyer_id,buyer_name,status,requires_response,external_status)
    values('mercado_livre',c.marketplace_account_id,'claim:'||c.external_case_id,'claim',c.order_id,buyer->>'id',buyer->>'display_name',
      case when c.status='closed' then 'closed' when c.needs_action is true then 'pending' else 'answered' end,c.needs_action is true,c.status)
    on conflict(marketplace,marketplace_account_id,external_conversation_id) do update set order_id=excluded.order_id,buyer_id=excluded.buyer_id,buyer_name=excluded.buyer_name,
      status=excluded.status,requires_response=excluded.requires_response,external_status=excluded.external_status,updated_at=now() returning id into conversation;
  update marketplace_cases set conversation_id=conversation where id=v_case_id;
  for m in select value from jsonb_array_elements(p_observation->'claim_messages') loop
    insert into marketplace_conversation_messages(conversation_id,marketplace_account_id,external_message_id,external_message_key,direction,message_type,text,sender_id,sender_name,sent_at,status,raw_data)
      values(conversation,c.marketplace_account_id,m->>'key','ml-claim:'||c.external_case_id||':'||(m->>'key'),m->>'direction','text',m->>'text',
        case when m->>'direction'='incoming' then buyer->>'id' else null end,
        case when m->>'direction'='incoming' then buyer->>'display_name' when m->>'direction'='outgoing' then 'Vendedor' else 'Mercado Livre' end,
        (m->>'at')::timestamptz,case when m->'raw'->>'official_status' in ('rejected','moderated') then 'blocked' when m->>'direction'='outgoing' then 'sent' else 'received' end,m->'raw')
      on conflict(conversation_id,external_message_id) do update set text=excluded.text,raw_data=excluded.raw_data,status=excluded.status;
  end loop;
  for e in select value from jsonb_array_elements(coalesce(p_observation->'claim_events','[]')) loop
    if e->>'official_at' is not null then
      insert into marketplace_case_timeline(case_id,transition_key,event_type,state,actor,official_at,observed_at,source)
        values(v_case_id,e->>'key',e->>'event_type',coalesce(e->'state','{}'),coalesce(e->>'actor','unknown'),(e->>'official_at')::timestamptz,
          (p_observation->>'observed_at')::timestamptz,e->>'source') on conflict(case_id,transition_key) do nothing;
    end if;
  end loop;
  return v_case_id;
end $$;
revoke all on function public.enqueue_marketplace_claim_operation(uuid,uuid,jsonb),public.begin_marketplace_claim_send(uuid),public.persist_marketplace_case(jsonb),public.persist_marketplace_case_base(jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_marketplace_claim_operation(uuid,uuid,jsonb),public.begin_marketplace_claim_send(uuid),public.persist_marketplace_case(jsonb),public.persist_marketplace_case_base(jsonb) to service_role;
