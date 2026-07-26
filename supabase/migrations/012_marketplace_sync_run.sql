-- Identifica em qual sincronizacao cada anuncio foi visto pela ultima vez.
alter table product_marketplaces
  add column if not exists last_seen_run_id uuid;

create index if not exists idx_product_marketplaces_account_seen_run
  on product_marketplaces(marketplace_account_id, last_seen_run_id);
