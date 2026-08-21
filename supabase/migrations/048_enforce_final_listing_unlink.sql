-- A classificacao final e autoritativa: sincronismos posteriores nao podem
-- religar o anuncio ao produto nem recriar a linha auxiliar de listings.
create or replace function public.enforce_final_marketplace_unlink()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.marketplace_listing_moderations m
    where m.marketplace = new.marketplace
      and m.marketplace_account_id = new.marketplace_account_id
      and m.listing_id = new.marketplace_product_id
      and m.classification = 'final'
  ) then
    new.product_id := null;
    new.existe_no_marketplace := false;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_final_marketplace_unlink on public.product_marketplaces;
create trigger enforce_final_marketplace_unlink
before insert or update on public.product_marketplaces
for each row execute function public.enforce_final_marketplace_unlink();

create or replace function public.block_final_listing_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.marketplace_listing_moderations m
    where m.marketplace = new.marketplace
      and m.marketplace_account_id = new.marketplace_account_id
      and m.listing_id = new.external_listing_id
      and m.classification = 'final'
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists block_final_listing_link on public.listings;
create trigger block_final_listing_link
before insert or update on public.listings
for each row execute function public.block_final_listing_link();

update public.product_marketplaces pm
set product_id = null,
    existe_no_marketplace = false,
    updated_at = now()
where exists (
  select 1
  from public.marketplace_listing_moderations m
  where m.marketplace = pm.marketplace
    and m.marketplace_account_id = pm.marketplace_account_id
    and m.listing_id = pm.marketplace_product_id
    and m.classification = 'final'
);

delete from public.listings l
using public.marketplace_listing_moderations m
where m.classification = 'final'
  and m.marketplace = l.marketplace
  and m.marketplace_account_id = l.marketplace_account_id
  and m.listing_id = l.external_listing_id;
