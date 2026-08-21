-- Disponibiliza todos os valores permitidos pelo enum, inclusive os que nao
-- possuem produtos associados no momento da consulta.
create or replace function list_product_statuses()
returns table(status text)
language sql
stable
security definer
set search_path = public
as $$
  select value::text
  from unnest(enum_range(null::product_status)) as value;
$$;

grant execute on function list_product_statuses() to anon, authenticated;
