drop view if exists public.products_with_link_type;

create view public.products_with_link_type
with (security_invoker = true)
as
select
  p.*,
  case
    when exists (
      select 1
      from public.listings l
      where l.product_id = p.id
        and nullif(btrim(l.external_listing_id), '') is not null
        and lower(coalesce(l.marketplace::text, '')) not in ('tiny', 'olist', 'olist_tiny', 'olisttiny')
    ) or exists (
      select 1
      from public.product_marketplaces pm
      where pm.product_id = p.id
        and pm.existe_no_marketplace = true
        and nullif(btrim(pm.marketplace_product_id), '') is not null
        and lower(coalesce(pm.marketplace::text, '')) not in ('tiny', 'olist', 'olist_tiny', 'olisttiny')
    ) then 'marketplace_linked'
    when nullif(btrim(p.tiny_product_id), '') is not null then 'tiny_only'
    else 'unlinked'
  end::text as integration_link_type,
  coalesce(e.estoque_disponivel, p.stock, 0)::integer as estoque_disponivel
from public.products p
left join public.estoque e on e.product_id = p.id;

grant select on public.products_with_link_type to authenticated, service_role;
