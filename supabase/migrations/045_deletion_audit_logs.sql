-- Auditoria central e recuperavel de exclusoes.
-- Os gatilhos no banco capturam exclusoes feitas pela aplicacao, scripts,
-- Supabase Studio, SQL direto ou qualquer integracao futura.

create table if not exists deletion_audit_logs (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  operation text not null default 'DELETE' check (operation = 'DELETE'),
  record_id text,
  product_id uuid,
  sku text,
  marketplace text,
  listing_id text,
  tiny_product_id text,
  record_data jsonb not null,
  request_context jsonb not null default '{}',
  database_role text,
  client_address inet,
  transaction_id bigint,
  deleted_at timestamptz not null default now()
);

create index if not exists deletion_audit_logs_deleted_at_idx
  on deletion_audit_logs(deleted_at desc);
create index if not exists deletion_audit_logs_sku_idx
  on deletion_audit_logs(sku, deleted_at desc);
create index if not exists deletion_audit_logs_product_idx
  on deletion_audit_logs(product_id, deleted_at desc);
create index if not exists deletion_audit_logs_listing_idx
  on deletion_audit_logs(marketplace, listing_id, deleted_at desc);

alter table deletion_audit_logs enable row level security;

create or replace function audit_deleted_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_data jsonb := to_jsonb(old);
  resolved_product_id uuid;
  resolved_sku text;
  jwt_claims jsonb := '{}';
  request_headers jsonb := '{}';
begin
  begin
    jwt_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}');
  exception when others then
    jwt_claims := '{}';
  end;

  begin
    request_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
  exception when others then
    request_headers := '{}';
  end;

  begin
    resolved_product_id := nullif(old_data ->> 'product_id', '')::uuid;
  exception when invalid_text_representation then
    resolved_product_id := null;
  end;

  if tg_table_name = 'products' then
    resolved_product_id := nullif(old_data ->> 'id', '')::uuid;
  end if;

  resolved_sku := nullif(btrim(coalesce(
    old_data ->> 'sku',
    old_data ->> 'external_sku',
    old_data ->> 'seller_sku'
  )), '');

  if resolved_sku is null and resolved_product_id is not null and tg_table_name <> 'products' then
    select p.sku into resolved_sku from products p where p.id = resolved_product_id;
  end if;

  insert into deletion_audit_logs (
    table_name,
    record_id,
    product_id,
    sku,
    marketplace,
    listing_id,
    tiny_product_id,
    record_data,
    request_context,
    database_role,
    client_address,
    transaction_id
  ) values (
    tg_table_name,
    old_data ->> 'id',
    resolved_product_id,
    resolved_sku,
    nullif(old_data ->> 'marketplace', ''),
    nullif(coalesce(
      old_data ->> 'marketplace_product_id',
      old_data ->> 'external_listing_id',
      old_data ->> 'listing_id'
    ), ''),
    nullif(old_data ->> 'tiny_product_id', ''),
    old_data,
    jsonb_build_object(
      'jwt_claims', jwt_claims,
      'headers', request_headers,
      'application_name', current_setting('application_name', true)
    ),
    current_user,
    inet_client_addr(),
    txid_current()
  );

  return old;
end;
$$;

drop trigger if exists audit_products_delete on products;
create trigger audit_products_delete
before delete on products
for each row execute function audit_deleted_record();

drop trigger if exists audit_product_marketplaces_delete on product_marketplaces;
create trigger audit_product_marketplaces_delete
before delete on product_marketplaces
for each row execute function audit_deleted_record();

drop trigger if exists audit_listings_delete on listings;
create trigger audit_listings_delete
before delete on listings
for each row execute function audit_deleted_record();

drop trigger if exists audit_product_images_delete on product_images;
create trigger audit_product_images_delete
before delete on product_images
for each row execute function audit_deleted_record();

drop trigger if exists audit_estoque_delete on estoque;
create trigger audit_estoque_delete
before delete on estoque
for each row execute function audit_deleted_record();

comment on table deletion_audit_logs is
  'Historico imutavel de registros excluidos, com dados suficientes para auditoria e recuperacao manual.';
