-- O estado do chat Shopee é determinado pela direção da última mensagem.
with latest as (
  select distinct on (message.conversation_id)
    message.conversation_id,
    message.direction
  from marketplace_conversation_messages message
  join marketplace_conversations conversation on conversation.id = message.conversation_id
  where conversation.marketplace = 'shopee'
  order by message.conversation_id, message.sent_at desc, message.created_at desc
)
update marketplace_conversations conversation
set
  requires_response = latest.direction = 'incoming',
  unread = latest.direction = 'incoming',
  status = case when latest.direction = 'incoming' then 'pending' else 'answered' end,
  updated_at = now()
from latest
where conversation.id = latest.conversation_id;

-- Retroalimenta dados do anúncio/SKU nas perguntas já importadas do Mercado Livre.
update marketplace_conversations conversation
set
  product_id = coalesce(conversation.product_id, listing.product_id, sku_product.id),
  sku = coalesce(conversation.sku, listing.sku),
  product_title = coalesce(conversation.product_title, listing.titulo_marketplace, product.title, sku_product.title),
  product_price = coalesce(conversation.product_price, listing.valor_marketplace, product.price, sku_product.price),
  available_stock = coalesce(listing.estoque_marketplace, product_stock.estoque_disponivel, sku_stock.estoque_disponivel),
  product_status = coalesce(conversation.product_status, listing.status_anuncio),
  product_image_url = coalesce(conversation.product_image_url, listing.raw_data #>> '{pictures,0,secure_url}', listing.raw_data ->> 'thumbnail'),
  raw_data = conversation.raw_data || jsonb_build_object(
    'item_permalink', listing.raw_data ->> 'permalink',
    'marketplace_url', case when listing.raw_data ->> 'permalink' is not null then (listing.raw_data ->> 'permalink') || '#questions' else null end
  ),
  updated_at = now()
from product_marketplaces listing
left join products product on product.id = listing.product_id
left join estoque product_stock on product_stock.product_id = product.id
left join products sku_product on sku_product.sku = listing.sku
left join estoque sku_stock on sku_stock.product_id = sku_product.id
where conversation.marketplace = 'mercado_livre'
  and conversation.marketplace_account_id = listing.marketplace_account_id
  and conversation.listing_id = listing.marketplace_product_id;

-- Nome confirmado para o comprador já existente; sincronizações futuras consultam nome e sobrenome na API.
update marketplace_conversations
set buyer_name = 'Nilton Bernardo (NILTONBERNARDODASILVABERNAR)', updated_at = now()
where marketplace = 'mercado_livre'
  and buyer_id = '297562452';
