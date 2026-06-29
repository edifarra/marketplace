create table if not exists product_marketplaces (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  sku text not null,
  marketplace_account_id uuid references config_marketplace_accounts(id) on delete cascade,
  marketplace marketplace_code not null,
  marketplace_product_id text not null,
  titulo_marketplace text,
  valor_marketplace numeric(12,2) not null default 0,
  estoque_marketplace integer not null default 0,
  status_anuncio text,
  existe_no_marketplace boolean not null default true,
  raw_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(marketplace_account_id, marketplace_product_id)
);

create index if not exists idx_product_marketplaces_sku on product_marketplaces(sku);
create index if not exists idx_product_marketplaces_product_id on product_marketplaces(product_id);

create table if not exists migration_stock_logs (
  id uuid primary key default gen_random_uuid(),
  sku text,
  acao text not null,
  status text not null,
  mensagem text,
  detalhes jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_migration_stock_logs_sku on migration_stock_logs(sku);
create index if not exists idx_migration_stock_logs_created_at on migration_stock_logs(created_at);
