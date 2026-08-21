-- Reconstroi os vinculos operacionais de anuncios usando a leitura confirmada
-- por conta em product_marketplaces. Isso corrige IDs de uma loja gravados em
-- outra e impede que o mesmo anuncio seja associado duas vezes na mesma conta.

with canonical as (
  select distinct on (pm.product_id, pm.marketplace_account_id)
    pm.product_id,
    pm.marketplace,
    pm.marketplace_account_id,
    coalesce(a.name, pm.marketplace_account_id::text) as marketplace_name,
    pm.marketplace_product_id as external_listing_id,
    pm.sku as external_sku,
    case
      when lower(coalesce(pm.status_anuncio, '')) in ('active', 'normal') then 'active'::product_status
      else 'paused'::product_status
    end as status,
    greatest(coalesce(pm.estoque_marketplace, 0), 0) as stock,
    coalesce(pm.valor_marketplace, 0) as price,
    pm.updated_at as last_sync_at
  from product_marketplaces pm
  left join config_marketplace_accounts a on a.id = pm.marketplace_account_id
  where pm.existe_no_marketplace = true
    and pm.product_id is not null
    and pm.marketplace_account_id is not null
    and nullif(pm.marketplace_product_id, '') is not null
  order by pm.product_id, pm.marketplace_account_id, pm.updated_at desc, pm.id desc
)
update listings l
set marketplace = c.marketplace,
    marketplace_name = c.marketplace_name,
    external_listing_id = c.external_listing_id,
    external_sku = c.external_sku,
    status = c.status,
    stock = c.stock,
    price = c.price,
    last_sync_at = c.last_sync_at,
    error_message = null
from canonical c
where l.product_id = c.product_id
  and l.marketplace_account_id = c.marketplace_account_id
  and (
    l.marketplace is distinct from c.marketplace
    or l.marketplace_name is distinct from c.marketplace_name
    or l.external_listing_id is distinct from c.external_listing_id
    or l.external_sku is distinct from c.external_sku
    or l.status is distinct from c.status
    or l.stock is distinct from c.stock
    or l.price is distinct from c.price
    or l.last_sync_at is distinct from c.last_sync_at
    or l.error_message is not null
  );

with canonical as (
  select distinct on (pm.product_id, pm.marketplace_account_id)
    pm.product_id,
    pm.marketplace,
    pm.marketplace_account_id,
    coalesce(a.name, pm.marketplace_account_id::text) as marketplace_name,
    pm.marketplace_product_id as external_listing_id,
    pm.sku as external_sku,
    case
      when lower(coalesce(pm.status_anuncio, '')) in ('active', 'normal') then 'active'::product_status
      else 'paused'::product_status
    end as status,
    greatest(coalesce(pm.estoque_marketplace, 0), 0) as stock,
    coalesce(pm.valor_marketplace, 0) as price,
    pm.updated_at as last_sync_at
  from product_marketplaces pm
  left join config_marketplace_accounts a on a.id = pm.marketplace_account_id
  where pm.existe_no_marketplace = true
    and pm.product_id is not null
    and pm.marketplace_account_id is not null
    and nullif(pm.marketplace_product_id, '') is not null
  order by pm.product_id, pm.marketplace_account_id, pm.updated_at desc, pm.id desc
)
insert into listings (
  product_id, marketplace, marketplace_account_id, marketplace_name,
  external_listing_id, external_sku, status, stock, price, last_sync_at, error_message
)
select c.product_id, c.marketplace, c.marketplace_account_id, c.marketplace_name,
  c.external_listing_id, c.external_sku, c.status, c.stock, c.price, c.last_sync_at, null
from canonical c
where not exists (
  select 1 from listings l
  where l.product_id = c.product_id
    and l.marketplace_account_id = c.marketplace_account_id
);

-- Remove apenas vinculos cuja identificacao externa pertence comprovadamente
-- a outra conta. Registros sem evidencia suficiente permanecem intocados.
delete from listings l
where l.external_listing_id is not null
  and exists (
    select 1
    from product_marketplaces owner
    where owner.marketplace = l.marketplace
      and owner.marketplace_product_id = l.external_listing_id
      and (
        l.marketplace_account_id is null
        or owner.marketplace_account_id <> l.marketplace_account_id
      )
  )
  and not exists (
    select 1
    from product_marketplaces own
    where own.marketplace_account_id = l.marketplace_account_id
      and own.marketplace_product_id = l.external_listing_id
  );

create unique index if not exists listings_account_external_unique
  on listings(marketplace_account_id, external_listing_id)
  where marketplace_account_id is not null and external_listing_id is not null;
