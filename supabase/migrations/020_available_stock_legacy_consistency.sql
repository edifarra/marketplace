-- Mantem o campo legado products.stock alinhado ao saldo realmente vendavel.
-- Consumidores antigos deixam de interpretar estoque fisico como disponivel.

create or replace function mirror_available_stock_to_product()
returns trigger
language plpgsql
as $$
begin
  update products
     set stock = new.estoque_disponivel,
         updated_at = now()
   where id = new.product_id
     and stock is distinct from new.estoque_disponivel;
  return new;
end;
$$;

drop trigger if exists trg_mirror_available_stock_to_product on estoque;
create trigger trg_mirror_available_stock_to_product
after insert or update of estoque_disponivel on estoque
for each row execute function mirror_available_stock_to_product();

-- Corrige os registros existentes imediatamente na aplicacao da migration.
update products p
   set stock = e.estoque_disponivel,
       updated_at = now()
  from estoque e
 where e.product_id = p.id
   and p.stock is distinct from e.estoque_disponivel;
