-- Lote 1 do hardening: configuracoes e identidades acessiveis apenas pelo backend.
-- Estas tabelas usam chaves text/uuid; nao ha sequences proprias a proteger.

alter table public.settings enable row level security;
revoke all on table public.settings from public, anon, authenticated;
grant select, insert, update, delete on table public.settings to service_role;

-- O RLS de app_users foi habilitado originalmente na migration 015.
alter table public.app_users enable row level security;
revoke all on table public.app_users from public, anon, authenticated;
grant select, insert, update on table public.app_users to service_role;

-- A reserva de SKU faz select + insert/update diretamente com service_role e
-- compara current_number para evitar que duas reservas confirmem o mesmo valor.
alter table public.sku_counters enable row level security;
revoke all on table public.sku_counters from public, anon, authenticated;
grant select, insert, update on table public.sku_counters to service_role;

-- Complementa o hardening iniciado na migration 058 com privilegios explicitos.
alter table public.config_marketplace_accounts enable row level security;
revoke all on table public.config_marketplace_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.config_marketplace_accounts to service_role;

-- Tabela legada sem acesso direto no runtime atual. Mantida para compatibilidade
-- e disponivel ao service_role somente para leitura administrativa.
alter table public.config_marketplaces enable row level security;
revoke all on table public.config_marketplaces from public, anon, authenticated;
grant select on table public.config_marketplaces to service_role;

-- View legada segura por security_invoker desde a migration 058.
revoke all on table public.marketplace_accounts from public, anon, authenticated;
grant select on table public.marketplace_accounts to service_role;

-- Funcao de trigger interna de app_users; nao deve ficar executavel como RPC.
revoke execute on function public.set_app_users_updated_at() from public, anon, authenticated;

