-- Remove duplicatas antigas sem conta quando o mesmo anuncio ja possui um
-- vinculo identificado e recupere os demais a partir do registro sincronizado.
delete from listings as legacy
where legacy.marketplace_account_id is null
  and legacy.external_listing_id is not null
  and exists (
    select 1
    from listings as identified
    where identified.marketplace = legacy.marketplace
      and identified.external_listing_id = legacy.external_listing_id
      and identified.marketplace_account_id is not null
  );

delete from listings as legacy
where legacy.marketplace_account_id is null
  and exists (
    select 1
    from product_marketplaces as pm
    join listings as identified
      on identified.product_id = legacy.product_id
     and identified.marketplace_account_id = pm.marketplace_account_id
    where pm.marketplace = legacy.marketplace
      and pm.marketplace_product_id = legacy.external_listing_id
  );

update listings as legacy
set marketplace_account_id = pm.marketplace_account_id,
    marketplace_name = account.name,
    external_sku = coalesce(nullif(pm.sku, ''), legacy.external_sku),
    status = case when lower(coalesce(pm.status_anuncio, '')) = 'active' then 'active'::product_status else 'paused'::product_status end,
    stock = case
      when lower(coalesce(pm.status_anuncio, '')) in ('closed', 'inactive', 'under_review') then 0
      else greatest(coalesce(pm.estoque_marketplace, 0), 0)
    end,
    price = coalesce(pm.valor_marketplace, legacy.price),
    last_sync_at = coalesce(pm.updated_at, legacy.last_sync_at)
from product_marketplaces as pm
join config_marketplace_accounts as account on account.id = pm.marketplace_account_id
where legacy.marketplace_account_id is null
  and legacy.marketplace = pm.marketplace
  and legacy.external_listing_id = pm.marketplace_product_id;
