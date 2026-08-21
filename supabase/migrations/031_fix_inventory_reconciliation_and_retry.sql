-- Corrige referencias ambiguas entre colunas da tabela e campos de retorno da
-- funcao. O erro impedia a reserva de estoque de vendas validas.
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
begin
  select v.* into current_sale from venda v where v.id = p_sale_id for update;
  if not found then raise exception 'Venda % nao encontrada', p_sale_id; end if;

  for row_item in
    select e.product_id, e.sku, sum(i.quantidade)::integer quantidade
      from venda_item i
      join estoque e on upper(e.sku) = upper(i.sku)
     where i.venda_id = p_sale_id
     group by e.product_id, e.sku
  loop
    select e.estoque_fisico, e.estoque_disponivel
      into before_f, before_a
      from estoque e
     where e.product_id = row_item.product_id
     for update;

    after_f := before_f;
    after_a := before_a;

    if p_release and current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
      after_a := least(before_f, before_a + row_item.quantidade);
      update estoque e set estoque_disponivel = after_a, updated_at = now() where e.product_id = row_item.product_id;
      insert into estoque_movimentacao(product_id,sku,venda_id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,metadata)
      values(row_item.product_id,row_item.sku,p_sale_id,'CANCELAMENTO_RESERVA','Cancelamento de Venda Reservada',row_item.quantidade,before_f,after_f,before_a,after_a,jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id))
      on conflict do nothing;
    elsif p_deduct_physical and not current_sale.physical_stock_deducted then
      if not current_sale.inventory_reserved then after_a := greatest(before_a - row_item.quantidade, 0); end if;
      after_f := greatest(before_f - row_item.quantidade, 0);
      update estoque e set estoque_fisico = after_f, estoque_disponivel = least(after_f, after_a), updated_at = now() where e.product_id = row_item.product_id;
      insert into estoque_movimentacao(product_id,sku,venda_id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,metadata)
      values(row_item.product_id,row_item.sku,p_sale_id,'VENDA_REALIZADA','Venda Realizada',-row_item.quantidade,before_f,after_f,before_a,least(after_f,after_a),jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id))
      on conflict do nothing;
    elsif p_reserve and not current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
      after_a := greatest(before_a - row_item.quantidade, 0);
      update estoque e set estoque_disponivel = after_a, updated_at = now() where e.product_id = row_item.product_id;
      insert into estoque_movimentacao(product_id,sku,venda_id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,metadata)
      values(row_item.product_id,row_item.sku,p_sale_id,'VENDA_RESERVADA','Venda Reservada',-row_item.quantidade,before_f,before_f,before_a,after_a,jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id))
      on conflict do nothing;
    end if;
  end loop;

  if p_release and current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
    update venda v set inventory_reserved = false, inventory_processed_at = now() where v.id = p_sale_id;
  elsif p_deduct_physical and not current_sale.physical_stock_deducted then
    update venda v set inventory_reserved = false, physical_stock_deducted = true, inventory_processed_at = now() where v.id = p_sale_id;
  elsif p_reserve and not current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
    update venda v set inventory_reserved = true, inventory_processed_at = now() where v.id = p_sale_id;
  end if;

  return query
    select distinct e.product_id, e.estoque_disponivel
      from estoque e
      join venda_item i on upper(i.sku) = upper(e.sku)
     where i.venda_id = p_sale_id;
end;
$$;

-- Eventos afetados pelo bug devem voltar para a fila. O worker corrigido
-- reconhece tanto o webhook original quanto o notification aninhado legado.
update marketplace_activities
   set status = 'queued',
       processing_error = null,
       processed_at = null,
       next_attempt_at = now(),
       locked_at = null
 where marketplace = 'mercado_livre'
   and id in (
     select distinct h.activity_id
       from marketplace_activity_history h
      where h.stage = 'processing'
        and h.status in ('error', 'retry')
        and h.details ->> 'error' like '%estoque_disponivel%ambiguous%'
   );
