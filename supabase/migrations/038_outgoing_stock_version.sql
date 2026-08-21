alter table estoque add column if not exists stock_version bigint not null default 0;
alter table outgoing_marketplace_activities add column if not exists stock_version bigint;

create or replace function increment_stock_version()
returns trigger language plpgsql as $$
begin
  if row(new.estoque_fisico, new.estoque_disponivel)
     is distinct from row(old.estoque_fisico, old.estoque_disponivel) then
    new.stock_version := old.stock_version + 1;
  end if;
  return new;
end; $$;

drop trigger if exists trg_increment_stock_version on estoque;
create trigger trg_increment_stock_version before update on estoque
for each row execute function increment_stock_version();

create index if not exists idx_outgoing_stock_version
  on outgoing_marketplace_activities(product_id, stock_version desc)
  where activity_type = 'stock_update';
