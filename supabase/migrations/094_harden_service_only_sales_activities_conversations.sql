-- Lote 3 do hardening: vendas, filas, conversas e moderacoes apenas no backend.
-- O runtime usa exclusivamente service_role; nao ha policies publicas neste lote.

alter table public.venda enable row level security;
revoke all on table public.venda from public, anon, authenticated;
grant select, insert, update, delete on table public.venda to service_role;

alter table public.venda_item enable row level security;
revoke all on table public.venda_item from public, anon, authenticated;
grant select, insert, update, delete on table public.venda_item to service_role;

alter table public.status_venda enable row level security;
revoke all on table public.status_venda from public, anon, authenticated;
grant select, insert, update on table public.status_venda to service_role;

alter table public.marketplace_activities enable row level security;
revoke all on table public.marketplace_activities from public, anon, authenticated;
grant select, insert, update, delete on table public.marketplace_activities to service_role;

alter table public.marketplace_activity_history enable row level security;
revoke all on table public.marketplace_activity_history from public, anon, authenticated;
grant select, insert on table public.marketplace_activity_history to service_role;

alter table public.outgoing_marketplace_activities enable row level security;
revoke all on table public.outgoing_marketplace_activities from public, anon, authenticated;
grant select, insert, update, delete on table public.outgoing_marketplace_activities to service_role;

alter table public.outgoing_marketplace_activity_history enable row level security;
revoke all on table public.outgoing_marketplace_activity_history from public, anon, authenticated;
grant select, insert on table public.outgoing_marketplace_activity_history to service_role;

alter table public.marketplace_conversations enable row level security;
revoke all on table public.marketplace_conversations from public, anon, authenticated;
grant select, insert, update, delete on table public.marketplace_conversations to service_role;

alter table public.marketplace_conversation_messages enable row level security;
revoke all on table public.marketplace_conversation_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.marketplace_conversation_messages to service_role;

-- A tabela ja possui RLS desde a migration 044; explicita os privilegios finais.
alter table public.marketplace_listing_moderations enable row level security;
revoke all on table public.marketplace_listing_moderations from public, anon, authenticated;
grant select, insert, update, delete on table public.marketplace_listing_moderations to service_role;

-- RPCs operacionais chamadas exclusivamente pelo backend e pelo worker.
revoke execute on function public.claim_marketplace_activity_queue(integer) from public, anon, authenticated;
grant execute on function public.claim_marketplace_activity_queue(integer) to service_role;

revoke execute on function public.claim_outgoing_marketplace_activity_queue(integer) from public, anon, authenticated;
grant execute on function public.claim_outgoing_marketplace_activity_queue(integer) to service_role;

revoke execute on function public.requeue_outgoing_marketplace_activity(uuid, text) from public, anon, authenticated;
grant execute on function public.requeue_outgoing_marketplace_activity(uuid, text) to service_role;

revoke execute on function public.finalize_marketplace_conversation_reply(uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_marketplace_conversation_reply(uuid, text, text, text, timestamptz, jsonb) to service_role;

-- A reconciliacao atomica de reserva/baixa ja foi endurecida na 093. Reitera
-- aqui o limite por ser diretamente dependente de venda e venda_item.
revoke execute on function public.reconcile_sale_inventory(uuid, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.reconcile_sale_inventory(uuid, boolean, boolean, boolean) to service_role;

revoke execute on function public.audit_sale_inventory(uuid) from public, anon, authenticated;
grant execute on function public.audit_sale_inventory(uuid) to service_role;

revoke execute on function public.set_physical_inventory(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_physical_inventory(uuid, integer) to service_role;

revoke execute on function public.set_physical_inventory_manual(uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.set_physical_inventory_manual(uuid, integer, uuid, text) to service_role;

-- Funcoes internas de trigger nao sao endpoints RPC e nao devem ser chamadas.
revoke execute on function public.fill_marketplace_conversation_product() from public, anon, authenticated;
revoke execute on function public.reconcile_conversations_from_listing() from public, anon, authenticated;
revoke execute on function public.touch_marketplace_conversation_from_message() from public, anon, authenticated;

-- Protege somente sequences serial/identity ligadas a colunas deste lote. Hoje
-- isso inclui queue_position em outgoing_marketplace_activities; o bloco
-- tambem cobre futuras conversoes serial/identity sem atingir lotes posteriores.
do $$
declare
  sequence_name text;
begin
  for sequence_name in
    select distinct pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name)
      from information_schema.columns
      join (values
        ('venda'), ('venda_item'), ('status_venda'),
        ('marketplace_activities'), ('marketplace_activity_history'),
        ('outgoing_marketplace_activities'), ('outgoing_marketplace_activity_history'),
        ('marketplace_conversations'), ('marketplace_conversation_messages'),
        ('marketplace_listing_moderations')
      ) scoped_tables(table_name) using (table_name)
     where columns.table_schema = 'public'
       and pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name) is not null
  loop
    execute format('revoke all on sequence %s from public, anon, authenticated', sequence_name);
    execute format('grant usage, select, update on sequence %s to service_role', sequence_name);
  end loop;
end;
$$;
