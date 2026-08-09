-- Cache de pesquisas de preco (72 horas) e livro permanente de estoque.

create table if not exists price_search_cache (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  sku text not null,
  search_string text not null,
  source text not null default 'MERCADO_LIVRE_CATALOGO',
  listings jsonb not null default '[]'::jsonb,
  searched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_price_search_cache_recent
  on price_search_cache(product_id, searched_at desc);
alter table price_search_cache enable row level security;

create table if not exists estoque_movimentacao (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  sku text not null,
  venda_id uuid references venda(id) on delete set null,
  tipo text not null,
  descricao text not null,
  quantidade integer not null default 0,
  estoque_fisico_anterior integer not null,
  estoque_fisico_atual integer not null,
  estoque_disponivel_anterior integer not null,
  estoque_disponivel_atual integer not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_estoque_movimentacao_product_date
  on estoque_movimentacao(product_id, created_at desc, id desc);
create unique index if not exists idx_estoque_movimentacao_sale_type
  on estoque_movimentacao(venda_id, product_id, tipo) where venda_id is not null;
alter table estoque_movimentacao enable row level security;

-- Ponto inicial do historico: o fisico atual antes das reservas abertas.
insert into estoque_movimentacao(
  product_id, sku, tipo, descricao, quantidade,
  estoque_fisico_anterior, estoque_fisico_atual,
  estoque_disponivel_anterior, estoque_disponivel_atual, created_at
)
select e.product_id, e.sku, 'ENTRADA_INICIAL', 'Entrada Inicial de Estoque', e.estoque_fisico,
       0, e.estoque_fisico, 0, e.estoque_fisico,
       coalesce(p.created_at, now())
  from estoque e join products p on p.id = e.product_id
 where e.estoque_fisico > 0
   and not exists (select 1 from estoque_movimentacao m where m.product_id=e.product_id and m.tipo='ENTRADA_INICIAL');

-- Reconstroi o disponivel pelas vendas que ainda possuem reserva ativa.
with reserved as (
  select e.product_id, coalesce(sum(i.quantidade),0)::integer quantity
    from estoque e
    join venda_item i on upper(i.sku)=upper(e.sku)
    join venda v on v.id=i.venda_id
   where v.inventory_reserved and not v.physical_stock_deducted
   group by e.product_id
)
update estoque e
   set estoque_disponivel=greatest(e.estoque_fisico-coalesce(r.quantity,0),0), updated_at=now()
  from reserved r where r.product_id=e.product_id;

insert into estoque_movimentacao(
  product_id, sku, venda_id, tipo, descricao, quantidade,
  estoque_fisico_anterior, estoque_fisico_atual,
  estoque_disponivel_anterior, estoque_disponivel_atual, created_at, metadata
)
select e.product_id, e.sku, v.id, 'VENDA_RESERVADA', 'Venda Reservada', -i.quantidade,
       e.estoque_fisico, e.estoque_fisico,
       least(e.estoque_fisico, e.estoque_disponivel+i.quantidade), e.estoque_disponivel,
       coalesce(v.data_venda,v.created_at), jsonb_build_object('marketplace',v.marketplace,'order_id',v.order_id)
  from venda v join venda_item i on i.venda_id=v.id join estoque e on upper(e.sku)=upper(i.sku)
 where v.inventory_reserved and not v.physical_stock_deducted
on conflict do nothing;

create or replace function reconcile_sale_inventory(p_sale_id uuid, p_reserve boolean, p_release boolean, p_deduct_physical boolean)
returns table(product_id uuid, estoque_disponivel integer)
language plpgsql security definer set search_path=public as $$
declare current_sale venda%rowtype; row_item record; before_f integer; before_a integer; after_f integer; after_a integer;
begin
  select * into current_sale from venda where id=p_sale_id for update;
  if not found then raise exception 'Venda % nao encontrada', p_sale_id; end if;
  for row_item in select e.product_id,e.sku,sum(i.quantidade)::integer quantidade from venda_item i join estoque e on upper(e.sku)=upper(i.sku) where i.venda_id=p_sale_id group by e.product_id,e.sku loop
    select estoque_fisico,estoque_disponivel into before_f,before_a from estoque where product_id=row_item.product_id for update;
    after_f:=before_f; after_a:=before_a;
    if p_release and current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
      after_a:=least(before_f,before_a+row_item.quantidade);
      update estoque set estoque_disponivel=after_a,updated_at=now() where product_id=row_item.product_id;
      insert into estoque_movimentacao(product_id,sku,venda_id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,metadata)
      values(row_item.product_id,row_item.sku,p_sale_id,'CANCELAMENTO_RESERVA','Cancelamento de Venda Reservada',row_item.quantidade,before_f,after_f,before_a,after_a,jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id)) on conflict do nothing;
    elsif p_deduct_physical and not current_sale.physical_stock_deducted then
      if not current_sale.inventory_reserved then after_a:=greatest(before_a-row_item.quantidade,0); end if;
      after_f:=greatest(before_f-row_item.quantidade,0);
      update estoque set estoque_fisico=after_f,estoque_disponivel=least(after_f,after_a),updated_at=now() where product_id=row_item.product_id;
      insert into estoque_movimentacao(product_id,sku,venda_id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,metadata)
      values(row_item.product_id,row_item.sku,p_sale_id,'VENDA_REALIZADA','Venda Realizada',-row_item.quantidade,before_f,after_f,before_a,least(after_f,after_a),jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id)) on conflict do nothing;
    elsif p_reserve and not current_sale.inventory_reserved and not current_sale.physical_stock_deducted then
      after_a:=greatest(before_a-row_item.quantidade,0);
      update estoque set estoque_disponivel=after_a,updated_at=now() where product_id=row_item.product_id;
      insert into estoque_movimentacao(product_id,sku,venda_id,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual,metadata)
      values(row_item.product_id,row_item.sku,p_sale_id,'VENDA_RESERVADA','Venda Reservada',-row_item.quantidade,before_f,before_f,before_a,after_a,jsonb_build_object('marketplace',current_sale.marketplace,'order_id',current_sale.order_id)) on conflict do nothing;
    end if;
  end loop;
  if p_release and current_sale.inventory_reserved and not current_sale.physical_stock_deducted then update venda set inventory_reserved=false,inventory_processed_at=now() where id=p_sale_id;
  elsif p_deduct_physical and not current_sale.physical_stock_deducted then update venda set inventory_reserved=false,physical_stock_deducted=true,inventory_processed_at=now() where id=p_sale_id;
  elsif p_reserve and not current_sale.inventory_reserved and not current_sale.physical_stock_deducted then update venda set inventory_reserved=true,inventory_processed_at=now() where id=p_sale_id; end if;
  return query select distinct e.product_id,e.estoque_disponivel from estoque e join venda_item i on upper(i.sku)=upper(e.sku) where i.venda_id=p_sale_id;
end; $$;

create or replace function set_physical_inventory(p_product_id uuid,p_quantity integer)
returns integer language plpgsql security definer set search_path=public as $$
declare reserved_quantity integer; available_quantity integer; before_f integer; before_a integer; row_sku text; target integer;
begin
  select estoque_fisico,estoque_disponivel,sku into before_f,before_a,row_sku from estoque where product_id=p_product_id for update;
  target:=greatest(coalesce(p_quantity,0),0);
  select coalesce(sum(i.quantidade),0)::integer into reserved_quantity from venda_item i join venda v on v.id=i.venda_id join estoque e on upper(e.sku)=upper(i.sku) where e.product_id=p_product_id and v.inventory_reserved and not v.physical_stock_deducted;
  available_quantity:=greatest(target-reserved_quantity,0);
  update estoque set estoque_fisico=target,estoque_disponivel=available_quantity,updated_at=now() where product_id=p_product_id;
  if before_f is distinct from target then
    insert into estoque_movimentacao(product_id,sku,tipo,descricao,quantidade,estoque_fisico_anterior,estoque_fisico_atual,estoque_disponivel_anterior,estoque_disponivel_atual)
    values(p_product_id,row_sku,case when target>before_f then 'ADICAO_MANUAL' else 'RETIRADA_MANUAL' end,case when target>before_f then 'Adicionado Manualmente' else 'Retirado Manualmente' end,target-before_f,before_f,target,before_a,available_quantity);
  end if;
  return available_quantity;
end; $$;
