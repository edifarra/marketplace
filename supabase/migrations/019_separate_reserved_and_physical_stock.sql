-- Separa reserva comercial da baixa fisica e torna as transicoes idempotentes.

drop trigger if exists trg_set_estoque_disponivel on estoque;
drop function if exists set_estoque_disponivel();

alter table status_venda add column if not exists deducts_physical_stock boolean not null default false;
alter table status_venda add column if not exists releases_stock boolean not null default false;

alter table venda add column if not exists inventory_reserved boolean not null default false;
alter table venda add column if not exists physical_stock_deducted boolean not null default false;
alter table venda add column if not exists inventory_processed_at timestamptz;

-- Toda venda aberta reserva, inclusive a ainda nao paga. Cancelamento libera a
-- reserva; postagem/coleta faz a baixa fisica uma unica vez.
update status_venda
set reserves_stock = internal_status not in ('cancelada', 'reembolsada')
                     and internal_status not in ('a_caminho', 'saiu_para_entrega', 'entregue', 'concluida'),
    releases_stock = internal_status in ('cancelada', 'reembolsada'),
    deducts_physical_stock = internal_status in ('a_caminho', 'saiu_para_entrega', 'entregue', 'concluida');

-- Marca o estado legado sem movimentar saldo novamente. Isso evita que a
-- proxima notificacao de um pedido antigo repita uma reserva ou uma postagem.
update venda v
set inventory_reserved = s.reserves_stock,
    physical_stock_deducted = s.deducts_physical_stock,
    inventory_processed_at = coalesce(v.updated_at, now())
from status_venda s
where s.id = v.status_id;

create or replace function reconcile_sale_inventory(
  p_sale_id uuid,
  p_reserve boolean,
  p_release boolean,
  p_deduct_physical boolean
)
returns table(product_id uuid, estoque_disponivel integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_sale venda%rowtype;
begin
  select * into current_sale from venda where id = p_sale_id for update;
  if not found then raise exception 'Venda % nao encontrada', p_sale_id; end if;

  -- Cancelar antes da postagem devolve somente a reserva ao disponivel.
  if p_release and current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
    update estoque e
       set estoque_disponivel = least(e.estoque_fisico, e.estoque_disponivel + i.quantidade),
           updated_at = now()
      from (select sku, sum(quantidade)::integer quantidade from venda_item where venda_id = p_sale_id group by sku) i
     where upper(e.sku) = upper(i.sku);
    update venda set inventory_reserved = false, inventory_processed_at = now() where id = p_sale_id;

  -- A primeira postagem converte a reserva em baixa fisica. O disponivel ja
  -- foi reduzido na venda e, portanto, nao e reduzido novamente.
  elsif p_deduct_physical and not current_sale.physical_stock_deducted then
    if not current_sale.inventory_reserved then
      update estoque e
         set estoque_disponivel = greatest(e.estoque_disponivel - i.quantidade, 0), updated_at = now()
        from (select sku, sum(quantidade)::integer quantidade from venda_item where venda_id = p_sale_id group by sku) i
       where upper(e.sku) = upper(i.sku);
    end if;
    update estoque e
       set estoque_fisico = greatest(e.estoque_fisico - i.quantidade, 0), updated_at = now()
      from (select sku, sum(quantidade)::integer quantidade from venda_item where venda_id = p_sale_id group by sku) i
     where upper(e.sku) = upper(i.sku);
    update venda
       set inventory_reserved = false, physical_stock_deducted = true, inventory_processed_at = now()
     where id = p_sale_id;

  elsif p_reserve and not current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
    update estoque e
       set estoque_disponivel = greatest(e.estoque_disponivel - i.quantidade, 0), updated_at = now()
      from (select sku, sum(quantidade)::integer quantidade from venda_item where venda_id = p_sale_id group by sku) i
     where upper(e.sku) = upper(i.sku);
    update venda set inventory_reserved = true, inventory_processed_at = now() where id = p_sale_id;
  end if;

  return query
  select distinct e.product_id, e.estoque_disponivel
    from estoque e join venda_item i on upper(i.sku) = upper(e.sku)
   where i.venda_id = p_sale_id;
end;
$$;

-- Conferencias e importacoes alteram o fisico, preservando as reservas abertas.
create or replace function set_physical_inventory(p_product_id uuid, p_quantity integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reserved_quantity integer;
  available_quantity integer;
begin
  select coalesce(sum(i.quantidade), 0)::integer into reserved_quantity
    from venda_item i
    join venda v on v.id = i.venda_id
    join estoque e on upper(e.sku) = upper(i.sku)
   where e.product_id = p_product_id and v.inventory_reserved and not v.physical_stock_deducted;

  available_quantity := greatest(greatest(coalesce(p_quantity, 0), 0) - reserved_quantity, 0);
  update estoque
     set estoque_fisico = greatest(coalesce(p_quantity, 0), 0),
         estoque_disponivel = available_quantity,
         updated_at = now()
   where product_id = p_product_id;
  return available_quantity;
end;
$$;
