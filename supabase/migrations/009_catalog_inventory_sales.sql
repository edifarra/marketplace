-- Catalogo permanente, estoque centralizado, categorias e atividades de marketplace.

create table if not exists estoque (
  product_id uuid primary key references products(id) on delete cascade,
  sku text not null unique,
  estoque_fisico integer not null default 0 check (estoque_fisico >= 0),
  estoque_disponivel integer not null default 0 check (estoque_disponivel >= 0),
  updated_at timestamptz not null default now()
);

create or replace function ensure_product_inventory()
returns trigger language plpgsql as $$
begin
  insert into estoque(product_id, sku, estoque_fisico, estoque_disponivel)
  values (new.id, new.sku, greatest(coalesce(new.stock, 0), 0), greatest(coalesce(new.stock, 0), 0))
  on conflict (product_id) do update set sku = excluded.sku, updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ensure_product_inventory on products;
create trigger trg_ensure_product_inventory
after insert or update of sku on products
for each row execute function ensure_product_inventory();

insert into estoque(product_id, sku, estoque_fisico, estoque_disponivel)
select id, sku, greatest(coalesce(stock, 0), 0), greatest(coalesce(stock, 0), 0)
from products
on conflict (product_id) do update
set sku = excluded.sku,
    estoque_fisico = excluded.estoque_fisico,
    estoque_disponivel = excluded.estoque_disponivel,
    updated_at = now();

create or replace function set_estoque_disponivel()
returns trigger
language plpgsql
as $$
begin
  -- Nesta etapa vendas em aberto = 0. A funcao concentra a regra para que
  -- a reserva de pedidos possa ser acrescentada sem alterar os consumidores.
  new.estoque_fisico := greatest(coalesce(new.estoque_fisico, 0), 0);
  new.estoque_disponivel := new.estoque_fisico;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_estoque_disponivel on estoque;
create trigger trg_set_estoque_disponivel
before insert or update of estoque_fisico on estoque
for each row execute function set_estoque_disponivel();

create table if not exists marketplace_category_mappings (
  internal_category text primary key,
  mercado_livre_code text,
  mercado_livre_description text,
  shopee_code text,
  shopee_description text,
  tiny_code text,
  tiny_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists status_venda (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  external_status text not null,
  internal_status text not null,
  description text,
  reserves_stock boolean not null default false,
  final_status boolean not null default false,
  unique(marketplace, external_status)
);

insert into status_venda(marketplace, external_status, internal_status, description, reserves_stock, final_status) values
  ('mercado_livre', 'confirmed', 'criada', 'Venda confirmada', true, false),
  ('mercado_livre', 'payment_required', 'nao_paga', 'Pagamento pendente', true, false),
  ('mercado_livre', 'payment_in_process', 'pagamento_em_processamento', 'Pagamento em processamento', true, false),
  ('mercado_livre', 'paid', 'paga', 'Venda paga', false, false),
  ('mercado_livre', 'cancelled', 'cancelada', 'Venda cancelada', false, true),
  ('mercado_livre', 'refunded', 'reembolsada', 'Venda reembolsada', false, true),
  ('shopee', 'UNPAID', 'nao_paga', 'Pagamento pendente', true, false),
  ('shopee', 'READY_TO_SHIP', 'paga', 'Pronta para envio', false, false),
  ('shopee', 'PROCESSED', 'processada', 'Pedido processado', false, false),
  ('shopee', 'SHIPPED', 'enviada', 'Pedido enviado', false, false),
  ('shopee', 'COMPLETED', 'concluida', 'Pedido concluido', false, true),
  ('shopee', 'IN_CANCEL', 'cancelamento_solicitado', 'Cancelamento solicitado', false, false),
  ('shopee', 'CANCELLED', 'cancelada', 'Pedido cancelado', false, true),
  ('shopee', 'TO_RETURN', 'devolucao_solicitada', 'Devolucao solicitada', false, false)
on conflict (marketplace, external_status) do update
set internal_status = excluded.internal_status,
    description = excluded.description,
    reserves_stock = excluded.reserves_stock,
    final_status = excluded.final_status;

create table if not exists venda (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  order_id text not null,
  status_id uuid references status_venda(id),
  status_original text,
  valor_produtos numeric(12,2) not null default 0,
  valor_frete numeric(12,2) not null default 0,
  valor_comissao numeric(12,2) not null default 0,
  valor_taxas numeric(12,2) not null default 0,
  valor_cashback numeric(12,2) not null default 0,
  valor_plataforma numeric(12,2) not null default 0,
  valor_descontos numeric(12,2) not null default 0,
  valor_liquido numeric(12,2) not null default 0,
  data_venda timestamptz,
  data_pagamento timestamptz,
  data_liberacao timestamptz,
  shipment_id text,
  raw_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(marketplace, order_id)
);

create table if not exists venda_item (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references venda(id) on delete cascade,
  order_id text not null,
  sku text not null,
  quantidade integer not null default 1 check (quantidade > 0),
  valor_unitario numeric(12,2) not null default 0,
  valor_total numeric(12,2) not null default 0,
  raw_data jsonb not null default '{}',
  unique(venda_id, sku)
);

create index if not exists idx_venda_order_id on venda(order_id);
create index if not exists idx_venda_created_at on venda(created_at desc);
create index if not exists idx_venda_item_sku on venda_item(sku);

create table if not exists marketplace_activities (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  event_type text,
  external_event_id text,
  order_id text,
  venda_id uuid references venda(id) on delete set null,
  description text,
  value numeric(12,2) not null default 0,
  item_count integer not null default 0,
  status text not null default 'received',
  raw_payload jsonb not null,
  processing_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_marketplace_activities_received_at on marketplace_activities(received_at desc);
create index if not exists idx_marketplace_activities_order_id on marketplace_activities(order_id);
create unique index if not exists idx_marketplace_activities_external_event
  on marketplace_activities(marketplace, external_event_id)
  where external_event_id is not null;

create table if not exists marketplace_activity_history (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references marketplace_activities(id) on delete cascade,
  stage text not null,
  status text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Os campos abaixo ficam temporariamente somente para leitura de instalacoes
-- antigas. Novos registros passam a persistir apenas os dados permanentes.
alter table products alter column type_code drop not null;
alter table products alter column brand_code drop not null;
alter table products alter column description drop not null;
alter table products alter column stock drop not null;
