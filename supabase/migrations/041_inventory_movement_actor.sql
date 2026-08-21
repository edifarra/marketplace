alter table estoque_movimentacao
  add column if not exists actor_user_id uuid references app_users(id) on delete set null,
  add column if not exists actor_name text not null default 'Sistema',
  add column if not exists actor_type text not null default 'system'
    check (actor_type in ('system', 'user', 'legacy_user'));

-- Registros automaticos antigos sao do sistema. Ajustes manuais antigos nao
-- guardavam autoria; identifica-los explicitamente evita atribuir nome errado.
update estoque_movimentacao
   set actor_name = 'Usuário não registrado', actor_type = 'legacy_user'
 where tipo in ('ADICAO_MANUAL', 'RETIRADA_MANUAL')
   and actor_user_id is null;

create or replace function set_physical_inventory_manual(
  p_product_id uuid,
  p_quantity integer,
  p_actor_user_id uuid,
  p_actor_name text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reserved_quantity integer;
  available_quantity integer;
  before_f integer;
  before_a integer;
  row_sku text;
  target integer;
  verified_actor_name text;
begin
  select name into verified_actor_name
    from app_users
   where id = p_actor_user_id and active = true;
  if verified_actor_name is null then
    raise exception 'Usuário responsável não encontrado ou inativo.';
  end if;
  if trim(coalesce(p_actor_name, '')) <> verified_actor_name then
    raise exception 'Identidade do usuário responsável não confere.';
  end if;

  select estoque_fisico, estoque_disponivel, sku
    into before_f, before_a, row_sku
    from estoque where product_id = p_product_id for update;
  if not found then raise exception 'Estoque do produto não encontrado.'; end if;

  target := greatest(coalesce(p_quantity, 0), 0);
  select coalesce(sum(i.quantidade), 0)::integer into reserved_quantity
    from venda_item i
    join venda v on v.id = i.venda_id
    join estoque e on upper(e.sku) = upper(i.sku)
   where e.product_id = p_product_id
     and v.inventory_reserved
     and not v.physical_stock_deducted;
  available_quantity := greatest(target - reserved_quantity, 0);

  update estoque set estoque_fisico = target,
    estoque_disponivel = available_quantity, updated_at = now()
   where product_id = p_product_id;

  if before_f is distinct from target then
    insert into estoque_movimentacao(
      product_id,sku,tipo,descricao,quantidade,
      estoque_fisico_anterior,estoque_fisico_atual,
      estoque_disponivel_anterior,estoque_disponivel_atual,
      actor_user_id,actor_name,actor_type,metadata
    ) values(
      p_product_id,row_sku,
      case when target > before_f then 'ADICAO_MANUAL' else 'RETIRADA_MANUAL' end,
      case when target > before_f then 'Adicionado Manualmente' else 'Retirado Manualmente' end,
      target-before_f,before_f,target,before_a,available_quantity,
      p_actor_user_id,verified_actor_name,'user',
      jsonb_build_object('actor_user_id',p_actor_user_id,'actor_name',verified_actor_name)
    );
  end if;
  return available_quantity;
end;
$$;
