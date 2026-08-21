-- Mantem categorias imutaveis para edicoes comuns, mas permite que o processo
-- de sincronizacao replique a categoria real retornada pelo marketplace.
create or replace function public.prevent_linked_product_category_change()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.marketplace_category_sync', true) = 'on' then
    return new;
  end if;

  if old.marketplace_attribute_schema_version >= 2
     and old.marketplace_categories <> '{}'::jsonb
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

create or replace function public.sync_product_marketplace_metadata(
  p_product_id uuid,
  p_categories jsonb,
  p_attributes jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.marketplace_category_sync', 'on', true);
  update public.products
  set marketplace_categories = coalesce(p_categories, '{}'::jsonb),
      marketplace_attributes = coalesce(p_attributes, '{}'::jsonb),
      updated_at = now()
  where id = p_product_id;
end;
$$;

revoke all on function public.sync_product_marketplace_metadata(uuid, jsonb, jsonb) from public;
grant execute on function public.sync_product_marketplace_metadata(uuid, jsonb, jsonb) to service_role;
