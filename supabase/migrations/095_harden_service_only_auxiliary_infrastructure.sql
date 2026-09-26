-- Lote 4 (final) do hardening: infraestrutura, caches e logs apenas no backend.
-- O runtime administrativo usa service_role; nenhuma policy publica e criada.

-- Tabela legada da migration inicial, substituida pelo dominio venda/venda_item.
-- Preserva acesso administrativo completo para compatibilidade e recuperacao.
alter table public.orders enable row level security;
revoke all on table public.orders from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.orders to service_role;

alter table public.pipeline_runs enable row level security;
revoke all on table public.pipeline_runs from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pipeline_runs to service_role;

alter table public.pipeline_logs enable row level security;
revoke all on table public.pipeline_logs from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pipeline_logs to service_role;

alter table public.tiny_sync_items enable row level security;
revoke all on table public.tiny_sync_items from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.tiny_sync_items to service_role;

alter table public.migration_stock_logs enable row level security;
revoke all on table public.migration_stock_logs from public, anon, authenticated, service_role;
grant select, insert on table public.migration_stock_logs to service_role;

-- A migration 029 desabilitou o RLS deste cache enquanto o servidor usava anon.
-- O acesso atual em price-evaluation ocorre com o cliente administrativo.
alter table public.price_search_cache enable row level security;
revoke all on table public.price_search_cache from public, anon, authenticated, service_role;
grant select, insert on table public.price_search_cache to service_role;

-- Tabela temporaria de diagnostico. Mantem leitura, carga e limpeza administrativas.
alter table public.price_search_debug_results enable row level security;
revoke all on table public.price_search_debug_results from public, anon, authenticated, service_role;
grant select, insert, delete on table public.price_search_debug_results to service_role;

alter table public.google_drive_folders enable row level security;
revoke all on table public.google_drive_folders from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.google_drive_folders to service_role;

-- Configuracao inclui o token cifrado do bot e nunca deve sair pela Data API.
alter table public.telegram_notification_config enable row level security;
revoke all on table public.telegram_notification_config from public, anon, authenticated, service_role;
grant select, update on table public.telegram_notification_config to service_role;

alter table public.telegram_notification_history enable row level security;
revoke all on table public.telegram_notification_history from public, anon, authenticated, service_role;
grant select, insert, update on table public.telegram_notification_history to service_role;

alter table public.telegram_notification_jobs enable row level security;
revoke all on table public.telegram_notification_jobs from public, anon, authenticated, service_role;
grant select, insert, update on table public.telegram_notification_jobs to service_role;

-- Log imutavel: o trigger SECURITY DEFINER grava e o backend pode auditar.
alter table public.deletion_audit_logs enable row level security;
revoke all on table public.deletion_audit_logs from public, anon, authenticated, service_role;
grant select on table public.deletion_audit_logs to service_role;

-- Funcao interna usada somente pelos triggers de auditoria de exclusao.
-- Assinatura conferida contra as migrations 045 e 046.
revoke execute on function public.audit_deleted_record() from public, anon, authenticated;

-- Protege explicitamente toda sequence serial/identity vinculada ao lote. Hoje
-- price_search_debug_results.id e a unica; o bloco cobre conversoes futuras.
do $$
declare
  sequence_name text;
begin
  for sequence_name in
    select distinct pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name)
      from information_schema.columns
      join (values
        ('orders'), ('pipeline_runs'), ('pipeline_logs'), ('tiny_sync_items'),
        ('migration_stock_logs'), ('price_search_cache'), ('price_search_debug_results'),
        ('google_drive_folders'), ('telegram_notification_config'),
        ('telegram_notification_history'), ('telegram_notification_jobs'),
        ('deletion_audit_logs')
      ) scoped_tables(table_name) using (table_name)
     where columns.table_schema = 'public'
       and pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name) is not null
  loop
    execute format('revoke all on sequence %s from public, anon, authenticated, service_role', sequence_name);
    execute format('grant usage, select, update on sequence %s to service_role', sequence_name);
  end loop;
end;
$$;
