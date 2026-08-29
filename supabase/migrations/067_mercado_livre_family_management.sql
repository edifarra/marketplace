alter table public.product_marketplaces
  add column if not exists family_id text,
  add column if not exists family_name text,
  add column if not exists user_product_id text;

create index if not exists idx_product_marketplaces_family_id
  on public.product_marketplaces(marketplace_account_id, family_id)
  where family_id is not null;

comment on column public.product_marketplaces.family_id is
  'Familia do User Product no Mercado Livre. O titulo dos anuncios desta familia e gerenciado pelo marketplace.';
