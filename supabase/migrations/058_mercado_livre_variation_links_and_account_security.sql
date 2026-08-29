alter table public.products
  add column if not exists mercado_livre_parent_listing_id text,
  add column if not exists mercado_livre_variation_id bigint;

comment on column public.products.mercado_livre_parent_listing_id is
  'ID do anuncio principal do Mercado Livre compartilhado por suas variacoes, por exemplo MLB5512385604.';
comment on column public.products.mercado_livre_variation_id is
  'ID numerico da variacao do Mercado Livre correspondente a este SKU.';

create index if not exists idx_products_ml_parent_variation
  on public.products (mercado_livre_parent_listing_id, mercado_livre_variation_id)
  where mercado_livre_parent_listing_id is not null;

update public.products
set mercado_livre_parent_listing_id = 'MLB5512385604',
    mercado_livre_variation_id = 184356019366,
    updated_at = now()
where upper(btrim(sku)) = 'GIR181-BRANCO';

-- As contas contêm client_secret, access_token e refresh_token. Elas só podem
-- ser acessadas pelo backend com service_role; a chave pública não deve ler a
-- tabela nem a view legada que também expunha esses campos.
alter table public.config_marketplace_accounts enable row level security;
revoke all on table public.config_marketplace_accounts from anon, authenticated;
grant all on table public.config_marketplace_accounts to service_role;

drop view if exists public.marketplace_accounts;
create view public.marketplace_accounts
with (security_invoker = true)
as
select
  id,
  marketplace,
  name as account_name,
  seller_id,
  shop_id,
  nickname,
  email,
  token_expires_at as expires_at,
  status,
  coalesce(last_sync_at, last_inventory_sync_at) as last_sync_at,
  created_at,
  updated_at
from public.config_marketplace_accounts;

revoke all on table public.marketplace_accounts from anon, authenticated;
grant select on table public.marketplace_accounts to service_role;

