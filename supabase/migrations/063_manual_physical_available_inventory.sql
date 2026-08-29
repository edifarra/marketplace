create or replace function set_inventory_quantities_manual(
  p_product_id uuid,
  p_physical_quantity integer,
  p_available_quantity integer,
  p_actor_user_id uuid,
  p_actor_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  before_f integer;
  before_a integer;
  row_sku text;
  target_f integer := greatest(coalesce(p_physical_quantity, 0), 0);
  target_a integer := greatest(coalesce(p_available_quantity, 0), 0);
  verified_actor_name text;
begin
  select name into verified_actor_name from app_users where id = p_actor_user_id and active = true;
  if verified_actor_name is null or trim(coalesce(p_actor_name, '')) <> verified_actor_name then
    raise exception 'Identidade do usuário responsável não confere.';
  end if;
  if target_a > target_f then raise exception 'Estoque disponível não pode ser maior que o estoque físico.'; end if;

  select estoque_fisico, estoque_disponivel, sku into before_f, before_a, row_sku
    from estoque where product_id = p_product_id for update;
  if not found then raise exception 'Estoque do produto não encontrado.'; end if;

  update estoque set estoque_fisico = target_f, estoque_disponivel = target_a, updated_at = now()
   where product_id = p_product_id;

  if before_f is distinct from target_f or before_a is distinct from target_a then
    insert into estoque_movimentacao(
      product_id,sku,tipo,descricao,quantidade,
      estoque_fisico_anterior,estoque_fisico_atual,
      estoque_disponivel_anterior,estoque_disponivel_atual,
      actor_user_id,actor_name,actor_type,metadata
    ) values(
      p_product_id,row_sku,
      case when target_f >= before_f then 'ADICAO_MANUAL' else 'RETIRADA_MANUAL' end,
      'Ajuste manual de estoque físico e disponível', target_f-before_f,
      before_f,target_f,before_a,target_a,
      p_actor_user_id,verified_actor_name,'user',
      jsonb_build_object('actor_user_id',p_actor_user_id,'actor_name',verified_actor_name,'available_adjustment',target_a-before_a)
    );
  end if;
end;
$$;

