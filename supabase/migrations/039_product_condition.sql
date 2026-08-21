alter table products add column if not exists product_condition text;

update products
set product_condition = 'used'
where product_condition is null or product_condition not in ('new', 'used');

alter table products alter column product_condition set default 'used';
alter table products alter column product_condition set not null;
alter table products drop constraint if exists products_product_condition_check;
alter table products add constraint products_product_condition_check
  check (product_condition in ('new', 'used'));
