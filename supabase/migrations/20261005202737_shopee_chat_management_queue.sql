-- Official Shopee chat actions: queue + remote-confirmed watermarks, service only.
alter table public.outgoing_marketplace_activities drop constraint if exists outgoing_marketplace_activities_activity_type_check;
alter table public.outgoing_marketplace_activities add constraint outgoing_marketplace_activities_activity_type_check
  check (activity_type in ('stock_update','listing_create','listing_update','listing_delete','answer_send','question_answer','conversation_read','conversation_delete'));

alter table public.marketplace_conversations
  add column shopee_last_message_id text,
  add column shopee_last_incoming_message_id text,
  add column shopee_read_message_id text,
  add column shopee_deleted_message_id text,
  add column shopee_deleted_at timestamptz,
  add constraint shopee_chat_watermark_ids check (
    (shopee_last_message_id is null or shopee_last_message_id ~ '^[1-9][0-9]{0,19}$') and
    (shopee_last_incoming_message_id is null or shopee_last_incoming_message_id ~ '^[1-9][0-9]{0,19}$') and
    (shopee_read_message_id is null or shopee_read_message_id ~ '^[1-9][0-9]{0,19}$') and
    (shopee_deleted_message_id is null or shopee_deleted_message_id ~ '^[1-9][0-9]{0,19}$')
  );

-- Backfill from exact external IDs already stored as text, never floating point.
with ids as (
  select conversation_id, max(external_message_id::numeric)::text as latest,
    (max(external_message_id::numeric) filter (where direction = 'incoming'))::text as incoming
  from public.marketplace_conversation_messages
  where external_message_id ~ '^[1-9][0-9]{0,19}$'
  group by conversation_id
)
update public.marketplace_conversations c
set shopee_last_message_id = ids.latest, shopee_last_incoming_message_id = ids.incoming
from ids where c.id = ids.conversation_id and c.marketplace = 'shopee';

create unique index idx_outgoing_pending_shopee_chat_action
  on public.outgoing_marketplace_activities(source_id)
  where destination = 'shopee' and activity_type in ('conversation_read','conversation_delete')
    and status in ('queued','processing','retry');

-- Reconciliation may race the worker. Enforce monotonic watermarks under the
-- row lock even when an upsert was built from a stale snapshot.
create function public.preserve_shopee_chat_action_state()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.marketplace <> 'shopee' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.shopee_last_message_id is not null and
      (new.shopee_last_message_id is null or new.shopee_last_message_id::numeric < old.shopee_last_message_id::numeric) then
      new.shopee_last_message_id := old.shopee_last_message_id;
    end if;
    if old.shopee_last_incoming_message_id is not null and
      (new.shopee_last_incoming_message_id is null or new.shopee_last_incoming_message_id::numeric < old.shopee_last_incoming_message_id::numeric) then
      new.shopee_last_incoming_message_id := old.shopee_last_incoming_message_id;
      new.unread := old.unread;
    end if;
  end if;
  if new.shopee_read_message_id is not null and new.shopee_last_message_id is not null then
    if new.shopee_last_message_id::numeric <= new.shopee_read_message_id::numeric then
      new.unread := false;
    elsif tg_op = 'UPDATE' and new.shopee_read_message_id is distinct from old.shopee_read_message_id then
      -- A new message arrived after the queued read snapshot.
      new.unread := old.unread;
    end if;
  end if;
  if new.shopee_deleted_message_id is not null and new.shopee_last_message_id is not null
    and new.shopee_last_message_id::numeric > new.shopee_deleted_message_id::numeric then
    new.shopee_deleted_at := null;
  end if;
  return new;
end;
$$;
create trigger trg_preserve_shopee_chat_action_state before insert or update
on public.marketplace_conversations for each row execute function public.preserve_shopee_chat_action_state();

create function public.enqueue_shopee_conversation_action(
  p_conversation_id uuid, p_action text, p_last_message_id text, p_operator_id uuid, p_operator_name text
) returns uuid language plpgsql security invoker set search_path = public as $$
declare c public.marketplace_conversations%rowtype; existing public.outgoing_marketplace_activities%rowtype; activity_id uuid;
begin
  if p_action is null or p_last_message_id is null or p_action not in ('conversation_read','conversation_delete') or p_last_message_id !~ '^[1-9][0-9]{0,19}$' then
    raise exception 'Ação ou ID de mensagem inválido.';
  end if;
  if not exists (select 1 from public.app_users where id = p_operator_id and active) then
    raise exception 'Operador não autorizado.';
  end if;
  select * into c from public.marketplace_conversations where id = p_conversation_id for update;
  if not found or c.marketplace <> 'shopee' or c.conversation_type <> 'chat' or c.shopee_deleted_at is not null then
    raise exception 'Conversa Shopee indisponível.';
  end if;
  if not exists (select 1 from public.config_marketplace_accounts where id = c.marketplace_account_id and active) then
    raise exception 'Conta Shopee inativa.';
  end if;
  select * into existing from public.outgoing_marketplace_activities
  where source_id = c.id::text and destination = 'shopee' and activity_type in ('conversation_read','conversation_delete')
    and status in ('queued','processing','retry') limit 1;
  if found then
    if existing.activity_type = p_action then return existing.id; end if;
    raise exception 'Outra ação deste chat já está na fila.';
  end if;
  if c.shopee_last_message_id is distinct from p_last_message_id then
    raise exception 'O chat foi atualizado. Atualize a tela antes de solicitar a ação.';
  end if;
  insert into public.outgoing_marketplace_activities(destination,activity_type,sku,product_name,marketplace_account_id,
    requested_data,source_type,source_id)
  values ('shopee',p_action,coalesce(c.sku,c.external_conversation_id),coalesce(c.product_title,'Conversa Shopee'),c.marketplace_account_id,
    jsonb_build_object('conversationId',c.id,'externalConversationId',c.external_conversation_id,'lastMessageId',p_last_message_id,
      'operatorId',p_operator_id,'operatorName',p_operator_name,'requestedAt',now()),'marketplace_conversation',c.id::text)
  returning id into activity_id;
  insert into public.outgoing_marketplace_activity_history(activity_id,attempt,stage,status,details)
  values (activity_id,0,'queued','queued',jsonb_build_object('action',p_action,'operatorId',p_operator_id));
  return activity_id;
end;
$$;

create function public.finalize_shopee_conversation_action(p_activity_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare a public.outgoing_marketplace_activities%rowtype; c public.marketplace_conversations%rowtype; watermark text;
begin
  select * into a from public.outgoing_marketplace_activities where id = p_activity_id for update;
  if not found or a.destination <> 'shopee' or a.source_type <> 'marketplace_conversation'
    or a.activity_type not in ('conversation_read','conversation_delete')
    or a.confirmed_data->'shopeeChatReceipt'->>'request_id' is null then
    raise exception 'Ação sem confirmação remota da Shopee.';
  end if;
  watermark := a.requested_data->>'lastMessageId';
  if watermark is null or watermark !~ '^[1-9][0-9]{0,19}$' then raise exception 'Mensagem inválida.'; end if;
  select * into c from public.marketplace_conversations where id = a.source_id::uuid for update;
  if not found or c.marketplace <> 'shopee' or c.marketplace_account_id <> a.marketplace_account_id
    or c.external_conversation_id <> a.requested_data->>'externalConversationId' then
    raise exception 'Conversa divergente da confirmação.';
  end if;
  if a.activity_type = 'conversation_read' then
    update public.marketplace_conversations set
      shopee_read_message_id = greatest(coalesce(shopee_read_message_id::numeric,0),watermark::numeric)::text,
      unread = case when coalesce(shopee_last_message_id::numeric,0) <= watermark::numeric then false else unread end,
      updated_at = clock_timestamp()
    where id = c.id;
  else
    update public.marketplace_conversations set
      shopee_deleted_message_id = watermark, shopee_deleted_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = c.id;
  end if;
end;
$$;

revoke all on function public.preserve_shopee_chat_action_state() from public, anon, authenticated;
revoke all on function public.enqueue_shopee_conversation_action(uuid,text,text,uuid,text) from public, anon, authenticated;
revoke all on function public.finalize_shopee_conversation_action(uuid) from public, anon, authenticated;
grant execute on function public.preserve_shopee_chat_action_state() to service_role;
grant execute on function public.enqueue_shopee_conversation_action(uuid,text,text,uuid,text) to service_role;
grant execute on function public.finalize_shopee_conversation_action(uuid) to service_role;

-- Keep page counts, filters and incremental removal consistent.
create or replace function public.get_marketplace_conversation_page(
  p_page integer default 1,
  p_page_size integer default 25,
  p_tab text default 'today',
  p_marketplace text default '',
  p_store uuid default null,
  p_status text default '',
  p_sla text default '',
  p_search text default '',
  p_from date default null,
  p_to date default null,
  p_unread boolean default false,
  p_with_product_hours numeric default 1,
  p_without_product_hours numeric default 6,
  p_now timestamptz default now()
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with watermark as (
    select id, updated_at
    from public.marketplace_conversations
    order by updated_at desc, id desc
    limit 1
  ), individual as (
    select
      conversation.id,
      conversation.marketplace,
      conversation.marketplace_account_id,
      conversation.conversation_type,
      conversation.status,
      conversation.requires_response,
      conversation.unread,
      conversation.buyer_id,
      conversation.buyer_name,
      conversation.product_id,
      conversation.listing_id,
      conversation.order_id,
      conversation.sku,
      conversation.product_title,
      conversation.last_incoming_at,
      conversation.last_message_at,
      case
        when conversation.marketplace = 'mercado_livre' and conversation.conversation_type = 'question'
          then 'ml:' || conversation.marketplace_account_id::text || ':'
            || case when coalesce(conversation.buyer_id, '') <> '' then conversation.buyer_id
              when conversation.buyer_name is null then 'null' else conversation.buyer_name end || ':'
            || case when coalesce(conversation.sku, '') <> '' then conversation.sku
              when conversation.listing_id is null then 'null' else conversation.listing_id end
        else 'single:' || conversation.id::text
      end as group_key,
      conversation.requires_response
        and p_now - coalesce(conversation.last_incoming_at, conversation.last_message_at)
          >= make_interval(secs => 3600 * case
            when conversation.product_id is not null or conversation.listing_id is not null
              then p_with_product_hours::double precision
            else p_without_product_hours::double precision
          end) as sla_breached
    from public.marketplace_conversations conversation
    where conversation.shopee_deleted_at is null
  ), grouped as (
    select
      group_key,
      array_agg(id order by last_message_at desc, id desc) as conversation_ids,
      count(*) as member_count,
      max(last_message_at) as last_message_at,
      (array_agg(id order by case when requires_response then 0 else 1 end, last_message_at desc, id desc))[1] as representative_id,
      bool_or(requires_response) as requires_response,
      bool_or(requires_response and unread) as pending_unread,
      bool_or(sla_breached) as sla_breached,
      (array_remove(array_agg(sku order by last_message_at desc, id desc), null))[1] as latest_sku,
      (array_remove(array_agg(product_title order by last_message_at desc, id desc), null))[1] as latest_product_title
    from individual
    group by group_key
  ), group_view as (
    select
      grouped.group_key,
      grouped.conversation_ids,
      grouped.last_message_at,
      representative.marketplace,
      representative.marketplace_account_id,
      representative.buyer_id,
      representative.buyer_name,
      representative.order_id,
      representative.listing_id,
      grouped.latest_sku as sku,
      grouped.latest_product_title as product_title,
      case when grouped.member_count > 1
        then case when grouped.requires_response then 'pending' else 'answered' end
        else representative.status
      end as status,
      case when grouped.member_count > 1 then grouped.pending_unread else representative.unread end as unread,
      grouped.requires_response,
      grouped.sla_breached
    from grouped
    join individual representative on representative.id = grouped.representative_id
  ), filtered as (
    select *
    from group_view
    where (p_tab = 'all' or requires_response or last_message_at >= p_now - interval '24 hours')
      and (coalesce(p_marketplace, '') = '' or marketplace = p_marketplace)
      and (p_store is null or marketplace_account_id = p_store)
      and (coalesce(p_status, '') = '' or status = p_status)
      and (
        coalesce(p_sla, '') = ''
        or (p_sla = 'outside' and sla_breached)
        or (p_sla <> 'outside' and requires_response and not sla_breached)
      )
      and (not p_unread or unread)
      and (p_from is null or last_message_at >= p_from::timestamp at time zone 'UTC')
      and (p_to is null or last_message_at <= (p_to::timestamp + interval '1 day' - interval '1 millisecond') at time zone 'UTC')
      and (
        coalesce(p_search, '') = ''
        or upper(coalesce(sku, '')) like '%' || upper(p_search) || '%'
        or upper(coalesce(product_title, '')) like '%' || upper(p_search) || '%'
        or upper(coalesce(buyer_name, '')) like '%' || upper(p_search) || '%'
        or upper(coalesce(buyer_id, '')) like '%' || upper(p_search) || '%'
        or upper(coalesce(order_id, '')) like '%' || upper(p_search) || '%'
        or upper(coalesce(listing_id, '')) like '%' || upper(p_search) || '%'
      )
  ), totals as (
    select count(*)::integer as total from filtered
  ), requested as (
    select
      total,
      greatest(1, least(greatest(1, coalesce(p_page, 1)), greatest(1, ceil(total::numeric / greatest(1, least(coalesce(p_page_size, 25), 100)))::integer))) as current_page,
      greatest(1, least(coalesce(p_page_size, 25), 100)) as page_size
    from totals
  ), page_groups as (
    select filtered.*, row_number() over (order by last_message_at desc, group_key) as page_order
    from filtered
    order by last_message_at desc, group_key
    limit (select page_size from requested)
    offset (select (current_page - 1) * page_size from requested)
  ), page_ids as (
    select member_id, page_order, member_order
    from page_groups
    cross join lateral unnest(conversation_ids) with ordinality as members(member_id, member_order)
  )
  select jsonb_build_object(
    'total', requested.total,
    'page', requested.current_page,
    'pageSize', requested.page_size,
    'cursor', jsonb_build_object(
      'updatedAt', coalesce((select updated_at from watermark), '1970-01-01T00:00:00Z'::timestamptz),
      'id', coalesce((select id from watermark), '00000000-0000-0000-0000-000000000000'::uuid)
    ),
    'conversationIds', coalesce((
      select jsonb_agg(member_id order by page_order, member_order) from page_ids
    ), '[]'::jsonb)
  )
  from requested;
$$;

revoke all on function public.get_marketplace_conversation_page(
  integer, integer, text, text, uuid, text, text, text, date, date, boolean, numeric, numeric, timestamptz
) from public, anon, authenticated;
grant execute on function public.get_marketplace_conversation_page(
  integer, integer, text, text, uuid, text, text, text, date, date, boolean, numeric, numeric, timestamptz
) to service_role;
