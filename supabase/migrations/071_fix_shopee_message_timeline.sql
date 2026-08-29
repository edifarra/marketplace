-- Repara os horários individuais das mensagens Shopee e remove a conversão textual de cartões.
alter table marketplace_conversations add column if not exists product_image_url text;

update marketplace_conversation_messages
set
  sent_at = to_timestamp((raw_data ->> 'created_timestamp')::numeric),
  text = case when text = '[object Object]' then '' else text end
where raw_data ? 'created_timestamp'
  and (raw_data ->> 'created_timestamp') ~ '^[0-9]+$'
  and conversation_id in (select id from marketplace_conversations where marketplace = 'shopee');

update marketplace_conversations conversation
set
  last_message_at = timeline.last_message_at,
  last_incoming_at = timeline.last_incoming_at,
  last_outgoing_at = timeline.last_outgoing_at,
  updated_at = now()
from (
  select
    conversation_id,
    max(sent_at) as last_message_at,
    max(sent_at) filter (where direction = 'incoming') as last_incoming_at,
    max(sent_at) filter (where direction = 'outgoing') as last_outgoing_at
  from marketplace_conversation_messages
  group by conversation_id
) timeline
where conversation.id = timeline.conversation_id
  and conversation.marketplace = 'shopee';

with linked_items as (
  select distinct on (message.conversation_id)
    message.conversation_id,
    coalesce(message.raw_data #>> '{source_content,item_id}', message.raw_data #>> '{content,item_id}') as item_id
  from marketplace_conversation_messages message
  where coalesce(message.raw_data #>> '{source_content,item_id}', message.raw_data #>> '{content,item_id}') is not null
  order by message.conversation_id, message.sent_at desc
)
update marketplace_conversations conversation
set listing_id = coalesce(conversation.listing_id, linked_items.item_id)
from linked_items
where conversation.id = linked_items.conversation_id
  and conversation.marketplace = 'shopee';

update marketplace_conversations conversation
set
  product_id = coalesce(conversation.product_id, listing.product_id),
  sku = coalesce(conversation.sku, listing.sku),
  product_title = coalesce(conversation.product_title, listing.titulo_marketplace, product.title),
  product_price = coalesce(conversation.product_price, listing.valor_marketplace, product.price),
  product_image_url = coalesce(conversation.product_image_url, listing.raw_data #>> '{image,image_url_list,0}', listing.raw_data #>> '{promotion_image,image_url_list,0}')
from product_marketplaces listing
left join products product on product.id = listing.product_id
where conversation.marketplace = 'shopee'
  and conversation.marketplace_account_id = listing.marketplace_account_id
  and listing.marketplace_product_id = coalesce(
    conversation.listing_id,
    conversation.raw_data #>> '{latest_message_content,item_id}',
    conversation.raw_data ->> 'item_id'
  );
