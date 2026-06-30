alter table config_marketplace_accounts add column if not exists shop_id text;
alter table config_marketplace_accounts add column if not exists nickname text;
alter table config_marketplace_accounts add column if not exists email text;
alter table config_marketplace_accounts add column if not exists status text not null default 'disconnected';
alter table config_marketplace_accounts add column if not exists raw_data jsonb;
alter table config_marketplace_accounts add column if not exists last_sync_at timestamptz;
alter table config_marketplace_accounts add column if not exists api_base_url text;

create index if not exists idx_config_marketplace_accounts_marketplace_seller
  on config_marketplace_accounts(marketplace, seller_id);

create index if not exists idx_config_marketplace_accounts_marketplace_shop
  on config_marketplace_accounts(marketplace, shop_id);

create or replace view marketplace_accounts as
select
  id,
  marketplace,
  name as account_name,
  seller_id,
  shop_id,
  nickname,
  email,
  access_token,
  refresh_token,
  token_expires_at as expires_at,
  status,
  raw_data,
  coalesce(last_sync_at, last_inventory_sync_at) as last_sync_at,
  created_at,
  updated_at
from config_marketplace_accounts;
