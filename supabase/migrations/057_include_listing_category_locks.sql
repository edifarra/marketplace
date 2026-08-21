-- Considera tanto o espelho de estoque quanto a tabela canonica de anuncios
-- ao decidir se a categoria individual do marketplace esta bloqueada.
create or replace function public.prevent_linked_product_category_change()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.marketplace_category_sync', true) = 'on' then
    return new;
  end if;

  if old.marketplace_attribute_schema_version >= 2 then
    if new.marketplace_categories -> 'mercado_livre' is distinct from old.marketplace_categories -> 'mercado_livre'
       and (
         exists (
           select 1 from product_marketplaces pm
           where pm.product_id = old.id and pm.marketplace = 'mercado_livre'
             and coalesce(pm.existe_no_marketplace, true) = true
             and nullif(pm.marketplace_product_id, '') is not null
         )
         or exists (
           select 1 from listings l
           where l.product_id = old.id and l.marketplace = 'mercado_livre'
             and nullif(l.external_listing_id, '') is not null
         )
       ) then
      raise exception 'A categoria do Mercado Livre nao pode ser alterada enquanto existir um anuncio vinculado.';
    end if;

    if new.marketplace_categories -> 'shopee' is distinct from old.marketplace_categories -> 'shopee'
       and (
         exists (
           select 1 from product_marketplaces pm
           where pm.product_id = old.id and pm.marketplace = 'shopee'
             and coalesce(pm.existe_no_marketplace, true) = true
             and nullif(pm.marketplace_product_id, '') is not null
         )
         or exists (
           select 1 from listings l
           where l.product_id = old.id and l.marketplace = 'shopee'
             and nullif(l.external_listing_id, '') is not null
         )
       ) then
      raise exception 'A categoria da Shopee nao pode ser alterada enquanto existir um anuncio vinculado.';
    end if;
  end if;
  return new;
end;
$$;
