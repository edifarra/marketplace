create table if not exists config_marketplace_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  marketplace marketplace_code not null,
  account_id text,
  category_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table listings add column if not exists marketplace_account_id uuid references config_marketplace_accounts(id);
alter table listings add column if not exists marketplace_name text;

alter table listings drop constraint if exists listings_product_id_marketplace_key;
create unique index if not exists listings_product_marketplace_account_unique
  on listings(product_id, marketplace_account_id)
  where marketplace_account_id is not null;

insert into config_marketplace_accounts(name, marketplace, active) values
('Mercado Livre 1', 'mercado_livre', true),
('Mercado Livre 2', 'mercado_livre', true),
('Shopee 1', 'shopee', true),
('Shopee 2', 'shopee', true)
on conflict do nothing;
