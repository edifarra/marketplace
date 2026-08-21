create table if not exists marketplace_listing_moderations (
  id uuid primary key default gen_random_uuid(),
  marketplace marketplace_code not null,
  marketplace_account_id uuid references config_marketplace_accounts(id) on delete set null,
  store_name text not null,
  sku text,
  product_name text not null,
  listing_id text not null,
  status text not null,
  classification text not null check (classification in ('final', 'review')),
  reason text,
  remedy text,
  source_event_id text,
  raw_data jsonb not null default '{}',
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(marketplace, marketplace_account_id, listing_id)
);

create index if not exists marketplace_listing_moderations_classification_event_idx
  on marketplace_listing_moderations(classification, event_at desc);
create index if not exists marketplace_listing_moderations_listing_idx
  on marketplace_listing_moderations(marketplace, listing_id);

alter table marketplace_listing_moderations enable row level security;
