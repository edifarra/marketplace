-- Auditoria persistente da baixa/reserva de estoque por venda e SKU.
create table if not exists venda_estoque_auditoria (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references venda(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  sku text not null,
  quantidade integer not null default 0,
  status text not null check (status in ('success','error')),
  movimento_esperado text,
  movimento_encontrado text,
  estoque_fisico integer,
  estoque_disponivel integer,
  reservas_ativas integer,
  estoque_disponivel_esperado integer,
  mensagem text not null,
  checked_at timestamptz not null default now(),
  unique(venda_id, sku)
);
create index if not exists idx_venda_estoque_auditoria_status
  on venda_estoque_auditoria(status, checked_at desc);
create index if not exists idx_venda_estoque_auditoria_product
  on venda_estoque_auditoria(product_id, checked_at desc);
alter table venda_estoque_auditoria disable row level security;

create or replace function audit_sale_inventory(p_sale_id uuid)
returns setof venda_estoque_auditoria
language plpgsql
security definer
set search_path = public
as $$
declare
  sale_row record;
  item_row record;
  inventory_row record;
  expected_movement text;
  found_movement text;
  active_reservations integer;
  expected_available integer;
  audit_status text;
  audit_message text;
begin
  select v.*, sv.reserves_stock, sv.releases_stock, sv.deducts_physical_stock
    into sale_row
    from venda v
    left join status_venda sv on sv.id = v.status_id
   where v.id = p_sale_id;
  if not found then raise exception 'Venda % nao encontrada para auditoria', p_sale_id; end if;

  for item_row in
    select upper(trim(i.sku)) sku, sum(i.quantidade)::integer quantidade
      from venda_item i
     where i.venda_id = p_sale_id
     group by upper(trim(i.sku))
  loop
    select e.product_id, e.estoque_fisico, e.estoque_disponivel
      into inventory_row
      from estoque e
     where upper(trim(e.sku)) = item_row.sku;

    if inventory_row.product_id is null then
      insert into venda_estoque_auditoria(venda_id,product_id,sku,quantidade,status,mensagem,checked_at)
      values(p_sale_id,null,item_row.sku,item_row.quantidade,'error','Produto ou registro de estoque nao localizado para o SKU.',now())
      on conflict(venda_id,sku) do update set product_id=null,quantidade=excluded.quantidade,status='error',mensagem=excluded.mensagem,checked_at=now();
      continue;
    end if;

    select coalesce(sum(i.quantidade),0)::integer
      into active_reservations
      from venda_item i
      join venda v on v.id = i.venda_id
     where upper(trim(i.sku)) = item_row.sku
       and v.inventory_reserved
       and not v.physical_stock_deducted;
    expected_available := greatest(inventory_row.estoque_fisico - active_reservations, 0);

    expected_movement := case
      when sale_row.physical_stock_deducted then 'VENDA_REALIZADA'
      when sale_row.inventory_reserved then 'VENDA_RESERVADA'
      when coalesce(sale_row.deducts_physical_stock,false) then 'VENDA_REALIZADA'
      when coalesce(sale_row.reserves_stock,false) then 'VENDA_RESERVADA'
      when coalesce(sale_row.releases_stock,false) then 'CANCELAMENTO_RESERVA'
      else null
    end;
    select m.tipo into found_movement
      from estoque_movimentacao m
     where m.venda_id = p_sale_id
       and m.product_id = inventory_row.product_id
       and (expected_movement is null or m.tipo = expected_movement)
     order by m.created_at desc limit 1;

    audit_status := case
      when inventory_row.estoque_disponivel <> expected_available then 'error'
      when expected_movement in ('VENDA_RESERVADA','VENDA_REALIZADA') and found_movement is null then 'error'
      else 'success'
    end;
    audit_message := case
      when inventory_row.estoque_disponivel <> expected_available then
        format('Saldo divergente: disponivel %s, esperado %s (fisico %s - reservas ativas %s).', inventory_row.estoque_disponivel, expected_available, inventory_row.estoque_fisico, active_reservations)
      when expected_movement in ('VENDA_RESERVADA','VENDA_REALIZADA') and found_movement is null then
        format('Movimentacao %s nao encontrada para a venda.', expected_movement)
      else format('Estoque auditado: fisico %s, disponivel %s, reservas ativas %s.', inventory_row.estoque_fisico, inventory_row.estoque_disponivel, active_reservations)
    end;

    insert into venda_estoque_auditoria(
      venda_id,product_id,sku,quantidade,status,movimento_esperado,movimento_encontrado,
      estoque_fisico,estoque_disponivel,reservas_ativas,estoque_disponivel_esperado,mensagem,checked_at
    ) values(
      p_sale_id,inventory_row.product_id,item_row.sku,item_row.quantidade,audit_status,expected_movement,found_movement,
      inventory_row.estoque_fisico,inventory_row.estoque_disponivel,active_reservations,expected_available,audit_message,now()
    ) on conflict(venda_id,sku) do update set
      product_id=excluded.product_id,quantidade=excluded.quantidade,status=excluded.status,
      movimento_esperado=excluded.movimento_esperado,movimento_encontrado=excluded.movimento_encontrado,
      estoque_fisico=excluded.estoque_fisico,estoque_disponivel=excluded.estoque_disponivel,
      reservas_ativas=excluded.reservas_ativas,estoque_disponivel_esperado=excluded.estoque_disponivel_esperado,
      mensagem=excluded.mensagem,checked_at=excluded.checked_at;

    if audit_status = 'error' then
      insert into estoque_movimentacao(
        product_id,sku,venda_id,tipo,descricao,quantidade,
        estoque_fisico_anterior,estoque_fisico_atual,
        estoque_disponivel_anterior,estoque_disponivel_atual,metadata
      ) values(
        inventory_row.product_id,item_row.sku,p_sale_id,'AUDITORIA_ESTOQUE_FALHA',audit_message,0,
        inventory_row.estoque_fisico,inventory_row.estoque_fisico,
        inventory_row.estoque_disponivel,inventory_row.estoque_disponivel,
        jsonb_build_object('marketplace',sale_row.marketplace,'order_id',sale_row.order_id,'audit_status','error')
      ) on conflict(venda_id,product_id,tipo) where venda_id is not null
        do update set descricao=excluded.descricao,metadata=excluded.metadata;
    end if;
  end loop;

  return query select a.* from venda_estoque_auditoria a where a.venda_id = p_sale_id order by a.sku;
end;
$$;

-- Gera a linha de base para vendas ja conhecidas sem alterar estoque.
do $$
declare sale_id uuid;
begin
  for sale_id in select v.id from venda v loop
    perform audit_sale_inventory(sale_id);
  end loop;
end;
$$;
