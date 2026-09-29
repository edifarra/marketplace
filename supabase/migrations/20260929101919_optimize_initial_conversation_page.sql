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
    where (p_tab = 'all' or last_message_at >= p_now - interval '24 hours')
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
