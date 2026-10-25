create schema if not exists tiny_retirement_archive;
revoke all on schema tiny_retirement_archive from public, anon, authenticated;

create table if not exists tiny_retirement_archive.product_links_20261025 (
 product_id uuid primary key,
 sku text,
 tiny_product_id text,
 tiny_last_synced_on date,
 archived_at timestamptz not null default now()
);

revoke all on all tables in schema tiny_retirement_archive from public, anon, authenticated;

do $$
declare v_count integer; v_total integer; v_stock bigint;
begin
 select count(*), coalesce(sum(stock),0)
 into v_total,v_stock from public.products;

 if v_total <> 3562 then
   raise exception 'Unexpected product count: %', v_total;
 end if;

 select count(*) into v_count
 from public.products
 where nullif(btrim(tiny_product_id),'') is not null;

 if v_count <> 3336 then
   raise exception 'Unexpected Tiny link count: %', v_count;
 end if;

 insert into tiny_retirement_archive.product_links_20261025(
   product_id,sku,tiny_product_id,tiny_last_synced_on
 )
 select id,sku,tiny_product_id,tiny_last_synced_on
 from public.products
 where tiny_product_id is not null
    or tiny_last_synced_on is not null;

 update public.products
 set tiny_product_id=null, tiny_last_synced_on=null
 where tiny_product_id is not null
    or tiny_last_synced_on is not null;

 if (select count(*) from public.products) <> v_total then
   raise exception 'Product count changed';
 end if;

 if (select coalesce(sum(stock),0) from public.products) <> v_stock then
   raise exception 'Stock sum changed';
 end if;

 if exists(
   select 1 from public.products
   where tiny_product_id is not null
      or tiny_last_synced_on is not null
 ) then
   raise exception 'Tiny links remain';
 end if;
end $$;