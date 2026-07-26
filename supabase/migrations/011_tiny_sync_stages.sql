-- Sincronizacao incremental do catalogo Tiny.

alter table products
  add column if not exists tiny_last_synced_on date;

create index if not exists idx_products_tiny_last_synced_on
  on products(tiny_last_synced_on);

create table if not exists tiny_sync_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  sku text not null,
  product_id uuid references products(id) on delete set null,
  tiny_product_id text,
  tiny_data jsonb not null default '{}',
  action text,
  status text not null default 'pending',
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, sku)
);

create index if not exists idx_tiny_sync_items_run_status
  on tiny_sync_items(run_id, status, action);
