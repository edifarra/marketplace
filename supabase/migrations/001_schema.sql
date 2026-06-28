create extension if not exists pgcrypto;

create type product_status as enum ('draft', 'ready', 'publishing', 'active', 'paused', 'error');
create type marketplace_code as enum ('mercado_livre', 'shopee');
create type pipeline_status as enum ('queued', 'running', 'done', 'failed');

create table settings (
  key text primary key,
  value jsonb not null default 'null',
  description text,
  updated_at timestamptz not null default now()
);

create table config_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,
  sku_max integer,
  marketplace_category text,
  weight_net numeric(10,3) default 0,
  weight_gross numeric(10,3) default 0,
  width numeric(10,2) default 0,
  height numeric(10,2) default 0,
  length numeric(10,2) default 0,
  description_template text,
  sku_group text not null,
  title_template text,
  warranty_months integer default 0,
  updated_at timestamptz not null default now()
);

create table config_brands (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  include_in_title boolean not null default false
);

create table config_specials (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  include_description text,
  remove_description text,
  keep_warranty boolean not null default false,
  notes text
);

create table config_marketplaces (
  id uuid primary key default gen_random_uuid(),
  product_type text not null references config_types(code),
  mercado_livre_category_id text,
  shopee_category_id text,
  mercado_livre_account_id text,
  shopee_shop_id text,
  unique(product_type)
);

create table sku_counters (
  sku_group text primary key,
  current_number integer not null default 0,
  updated_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  source_key text not null unique,
  type_code text not null references config_types(code),
  brand_code text not null references config_brands(code),
  special_code text references config_specials(code),
  model text,
  version text,
  board_code text,
  title text not null,
  description text not null,
  price numeric(12,2) not null default 0,
  stock integer not null default 1,
  status product_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  drive_file_id text,
  original_name text not null,
  url text,
  position integer not null,
  status text not null default 'pending',
  unique(product_id, position)
);

create table listings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  marketplace marketplace_code not null,
  external_listing_id text,
  external_sku text,
  status product_status not null default 'draft',
  stock integer not null default 0,
  price numeric(12,2) not null default 0,
  last_sync_at timestamptz,
  error_message text,
  unique(product_id, marketplace)
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  marketplace marketplace_code not null,
  external_order_id text not null,
  external_listing_id text,
  sku text,
  quantity integer not null,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(marketplace, external_order_id)
);

create table pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  status pipeline_status not null default 'queued',
  stage text not null default 'collect',
  metrics jsonb not null default '{}',
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table pipeline_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references pipeline_runs(id) on delete cascade,
  level text not null default 'info',
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index idx_products_status on products(status);
create index idx_listings_marketplace_status on listings(marketplace, status);
create index idx_orders_sku on orders(sku);
