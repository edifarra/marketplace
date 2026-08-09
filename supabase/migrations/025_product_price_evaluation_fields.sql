alter table products add column if not exists price_evaluation_status text;
alter table products add column if not exists price_evaluation_result jsonb;
alter table products add column if not exists price_evaluated_at timestamptz;
alter table products add column if not exists price_evaluation_error text;

create index if not exists idx_products_pending_price
  on products(status, created_at)
  where status = 'pending_price';
