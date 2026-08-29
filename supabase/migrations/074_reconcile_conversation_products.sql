-- Garante o vínculo mesmo quando pergunta e anúncio chegam fora de ordem.
create or replace function fill_marketplace_conversation_product()
returns trigger language plpgsql set search_path = public as $$
declare linked record;
begin
  if new.listing_id is null then return new; end if;
  select listing.product_id, listing.sku,
    coalesce(listing.titulo_marketplace, product.title) as title,
    coalesce(listing.valor_marketplace, product.price) as price,
    coalesce(stock.estoque_disponivel, listing.estoque_marketplace) as available_stock,
    listing.status_anuncio,
    coalesce(listing.raw_data #>> '{pictures,0,secure_url}', listing.raw_data #>> '{image,image_url_list,0}', listing.raw_data ->> 'thumbnail') as image_url,
    listing.raw_data ->> 'permalink' as permalink
  into linked
  from product_marketplaces listing
  left join products product on product.id = listing.product_id
  left join estoque stock on stock.product_id = listing.product_id
  where listing.marketplace_account_id = new.marketplace_account_id
    and listing.marketplace_product_id = new.listing_id limit 1;
  if found then
    new.product_id := coalesce(new.product_id, linked.product_id);
    new.sku := coalesce(new.sku, linked.sku);
    new.product_title := coalesce(new.product_title, linked.title);
    new.product_price := coalesce(new.product_price, linked.price);
    new.available_stock := coalesce(linked.available_stock, new.available_stock);
    new.product_status := coalesce(linked.status_anuncio, new.product_status);
    new.product_image_url := coalesce(new.product_image_url, linked.image_url);
    if linked.permalink is not null then
      new.raw_data := coalesce(new.raw_data, '{}'::jsonb) || jsonb_build_object(
        'item_permalink', linked.permalink,
        'marketplace_url', linked.permalink || case when new.conversation_type = 'question' then '#questions' else '' end);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fill_marketplace_conversation_product on marketplace_conversations;
create trigger trg_fill_marketplace_conversation_product
before insert or update of marketplace_account_id, listing_id, product_id, sku on marketplace_conversations
for each row execute function fill_marketplace_conversation_product();

create or replace function reconcile_conversations_from_listing()
returns trigger language plpgsql set search_path = public as $$
begin
  update marketplace_conversations conversation set
    product_id = coalesce(conversation.product_id, new.product_id),
    sku = coalesce(conversation.sku, new.sku),
    product_title = coalesce(new.titulo_marketplace, conversation.product_title),
    product_price = coalesce(new.valor_marketplace, conversation.product_price),
    available_stock = coalesce((select estoque_disponivel from estoque where product_id = new.product_id), new.estoque_marketplace, conversation.available_stock),
    product_status = coalesce(new.status_anuncio, conversation.product_status),
    product_image_url = coalesce(new.raw_data #>> '{pictures,0,secure_url}', new.raw_data #>> '{image,image_url_list,0}', new.raw_data ->> 'thumbnail', conversation.product_image_url),
    raw_data = conversation.raw_data || jsonb_strip_nulls(jsonb_build_object(
      'item_permalink', new.raw_data ->> 'permalink',
      'marketplace_url', case when new.raw_data ->> 'permalink' is not null then (new.raw_data ->> 'permalink') || case when conversation.conversation_type = 'question' then '#questions' else '' end else null end)),
    updated_at = now()
  where conversation.marketplace_account_id = new.marketplace_account_id
    and conversation.listing_id = new.marketplace_product_id;
  return new;
end;
$$;

drop trigger if exists trg_reconcile_conversations_from_listing on product_marketplaces;
create trigger trg_reconcile_conversations_from_listing
after insert or update of product_id, sku, titulo_marketplace, valor_marketplace, estoque_marketplace, status_anuncio, raw_data on product_marketplaces
for each row execute function reconcile_conversations_from_listing();

-- Aciona a reconciliação de todas as conversas existentes.
update marketplace_conversations set listing_id = listing_id where listing_id is not null;
