create or replace function prevent_linked_product_category_change()
returns trigger
language plpgsql
as $$
begin
  if old.marketplace_categories <> '{}'::jsonb
     and new.marketplace_categories is distinct from old.marketplace_categories
     and (
       exists (select 1 from product_marketplaces pm where pm.product_id = old.id and coalesce(pm.existe_no_marketplace, true) = true and nullif(pm.marketplace_product_id, '') is not null)
       or exists (select 1 from listings l where l.product_id = old.id and nullif(l.external_listing_id, '') is not null)
       or nullif(old.tiny_product_id, '') is not null
     ) then
    raise exception 'A categoria do produto nao pode ser alterada enquanto existirem vinculos com marketplaces.';
  end if;
  return new;
end;
$$;
