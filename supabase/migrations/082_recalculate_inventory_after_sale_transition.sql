-- Recalcula o saldo disponivel a partir da fonte de verdade depois de cada
-- transicao. Isso evita que o cancelamento de uma venda devolva unidades que
-- continuam reservadas por outra venda concorrente do mesmo SKU.
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
  row_item record;
  before_f integer;
  before_a integer;
  after_f integer;
  after_a integer;
  active_reservations integer;
  movement_type text;
  movement_description text;
  movement_quantity integer;
  should_release boolean;
  should_deduct boolean;
  should_reserve boolean;
begin
  select v.* into current_sale from venda v where v.id = p_sale_id for update;
  if not found then raise exception 'Venda % nao encontrada', p_sale_id; end if;

  should_release := p_release and current_sale.inventory_reserved and not current_sale.physical_stock_deducted;
  should_deduct := p_deduct_physical and not current_sale.physical_stock_deducted;
  should_reserve := p_reserve and not current_sale.inventory_reserved and not current_sale.physical_stock_deducted;

  -- Atualiza primeiro o estado logico da venda. O calculo abaixo passa a
  -- enxergar exatamente o conjunto de reservas que deve permanecer ativo.
  if should_release then
    update venda set inventory_reserved = false, inventory_processed_at = now() where id = p_sale_id;
  elsif should_deduct then
    update venda set inventory_reserved = false, physical_stock_deducted = true, inventory_processed_at = now() where id = p_sale_id;
  elsif should_reserve then
    update venda set inventory_reserved = true, inventory_processed_at = now() where id = p_sale_id;
  end if;

  for row_item in
    select e.product_id, e.sku, sum(i.quantidade)::integer quantidade
      from venda_item i
      join estoque e on upper(trim(e.sku)) = upper(trim(i.sku))
     where i.venda_id = p_sale_id
     group by e.product_id, e.sku
  loop
    select e.estoque_fisico, e.estoque_disponivel
      into before_f, before_a
      from estoque e where e.product_id = row_item.product_id for update;

    after_f := case when should_deduct then greatest(before_f - row_item.quantidade, 0) else before_f end;

    select coalesce(sum(i.quantidade), 0)::integer
      into active_reservations
      from venda_item i
      join venda v on v.id = i.venda_id
      join estoque e on upper(trim(e.sku)) = upper(trim(i.sku))
     where e.product_id = row_item.product_id
       and v.inventory_reserved
       and not v.physical_stock_deducted;
    after_a := greatest(after_f - active_reservations, 0);

    if should_release or should_deduct or should_reserve then
      update estoque e
         set estoque_fisico = after_f, estoque_disponivel = after_a, updated_at = now()
       where e.product_id = row_item.product_id;

      movement_type := case when should_release then 'CANCELAMENTO_RESERVA' when should_deduct then 'VENDA_REALIZADA' else 'VENDA_RESERVADA' end;
      movement_description := case when should_release then 'Cancelamento de Venda Reservada' when should_deduct then 'Venda Realizada' else 'Venda Reservada' end;
      movement_quantity := case when should_release then row_item.quantidade else -row_item.quantidade end;
      insert into estoque_movimentacao(
        product_id,sku,venda_id,tipo,descricao,quantidade,
        estoque_fisico_anterior,estoque_fisico_atual,
        estoque_disponivel_anterior,estoque_disponivel_atual,metadata
      ) values(
        row_item.product_id,row_item.sku,p_sale_id,movement_type,movement_description,movement_quantity,
        before_f,after_f,before_a,after_a,
        jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id)
      ) on conflict do nothing;
    end if;

    if row(before_f, before_a) is distinct from row(after_f, after_a) then
      product_id := row_item.product_id;
      estoque_disponivel := after_a;
      return next;
    end if;
  end loop;
end;
$$;

-- Repara saldos que ficaram divergentes antes desta correcao. A alteracao de
-- saldo incrementa stock_version e sera distribuida por uma reconciliacao das
-- integracoes logo apos a migration.
with expected as (
  select e.product_id,
         greatest(e.estoque_fisico - coalesce(sum(i.quantidade) filter (
           where v.inventory_reserved and not v.physical_stock_deducted
         ), 0), 0)::integer as estoque_disponivel
    from estoque e
    left join venda_item i on upper(trim(i.sku)) = upper(trim(e.sku))
    left join venda v on v.id = i.venda_id
   group by e.product_id, e.estoque_fisico
)
update estoque e
   set estoque_disponivel = expected.estoque_disponivel, updated_at = now()
  from expected
 where e.product_id = expected.product_id
   and e.estoque_disponivel is distinct from expected.estoque_disponivel;

-- Atualiza a auditoria dos dois pedidos que evidenciaram a corrida.
select audit_sale_inventory('51726d8c-12c2-4138-8e1f-bb6a84b71fdf');
select audit_sale_inventory('95b2ad93-8391-46b0-98be-443af49ff363');
