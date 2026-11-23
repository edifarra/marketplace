create table public.venda_financeiro_identificadores (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references public.venda(id) on delete cascade,
  marketplace_account_id uuid not null references public.config_marketplace_accounts(id) on delete restrict,
  identifier_type text not null check (length(btrim(identifier_type)) > 0),
  identifier_value text not null check (length(btrim(identifier_value)) > 0),
  source text not null check (length(btrim(source)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint venda_financeiro_identificadores_association_key
    unique (venda_id, marketplace_account_id, identifier_type, identifier_value)
);

create index venda_financeiro_identificadores_lookup_idx
  on public.venda_financeiro_identificadores (marketplace_account_id, identifier_type, identifier_value);
create index venda_financeiro_identificadores_venda_idx
  on public.venda_financeiro_identificadores (venda_id);

alter table public.venda_financeiro_identificadores enable row level security;
revoke all on public.venda_financeiro_identificadores from anon, authenticated;
grant all on public.venda_financeiro_identificadores to service_role;

create or replace function public.persist_sale_financial_identifiers(
  p_venda_id uuid,
  p_marketplace_account_id uuid,
  p_source text,
  p_identifiers jsonb
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  sale_row public.venda%rowtype;
  identifier jsonb;
  affected integer := 0;
begin
  if p_venda_id is null or p_marketplace_account_id is null
     or nullif(btrim(p_source), '') is null
     or jsonb_typeof(p_identifiers) is distinct from 'array' then
    raise exception 'Identidade ou lista de identificadores inválida';
  end if;

  select * into strict sale_row from public.venda where id = p_venda_id for update;
  if sale_row.marketplace <> 'mercado_livre'
     or sale_row.raw_data->>'marketplace_account_id' is distinct from p_marketplace_account_id::text then
    raise exception 'Venda não pertence à conta Mercado Livre informada';
  end if;

  for identifier in select value from jsonb_array_elements(p_identifiers) loop
    if nullif(btrim(identifier->>'identifierType'), '') is null
       or nullif(btrim(identifier->>'identifierValue'), '') is null then
      raise exception 'Identificador inválido';
    end if;
    insert into public.venda_financeiro_identificadores
      (venda_id, marketplace_account_id, identifier_type, identifier_value, source)
    values
      (p_venda_id, p_marketplace_account_id, btrim(identifier->>'identifierType'),
       btrim(identifier->>'identifierValue'), btrim(p_source))
    on conflict (venda_id, marketplace_account_id, identifier_type, identifier_value) do nothing;
    if found then affected := affected + 1; end if;
  end loop;
  return affected;
end;
$$;

revoke all on function public.persist_sale_financial_identifiers(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.persist_sale_financial_identifiers(uuid, uuid, text, jsonb) to service_role;

-- The sale write and associations commit or roll back together. No historical backfill.
create function public.capture_sale_financial_identifiers() returns trigger
language plpgsql security invoker set search_path = public, pg_temp
as $$
begin
  if new.marketplace <> 'mercado_livre' or new.raw_data->'sale_identifiers' is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.raw_data->>'marketplace_account_id' is not null
       and old.raw_data->>'marketplace_account_id' is distinct from new.raw_data->>'marketplace_account_id' then
      raise exception 'Venda pertence a outra conta Mercado Livre';
    end if;
    if old.raw_data->'sale_identifiers' is not distinct from new.raw_data->'sale_identifiers' then
      return new;
    end if;
  end if;
  perform public.persist_sale_financial_identifiers(
    new.id, (new.raw_data->>'marketplace_account_id')::uuid,
    new.raw_data->'sale_identifiers'->>'source',
    new.raw_data->'sale_identifiers'->'identifiers');
  return new;
end;
$$;
revoke all on function public.capture_sale_financial_identifiers() from public, anon, authenticated;
grant execute on function public.capture_sale_financial_identifiers() to service_role;
create trigger capture_sale_financial_identifiers
  after insert or update of raw_data on public.venda
  for each row execute function public.capture_sale_financial_identifiers();
