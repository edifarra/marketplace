alter type product_status add value if not exists 'sent';

alter table products add column if not exists tiny_product_id text;
alter table products add column if not exists sent_target text;
alter table products add column if not exists sent_at timestamptz;
