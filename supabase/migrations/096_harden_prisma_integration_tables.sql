-- Hardening das tabelas adicionais mantidas pelo Prisma e integracoes legadas.
-- A role postgres usada por DATABASE_URL e proprietaria destas tabelas e possui
-- BYPASSRLS, portanto o runtime e o Prisma Migrate nao dependem de policies.

revoke all on table public.integration_configs from public, anon, authenticated;
alter table public.integration_configs enable row level security;

revoke all on table public.integration_logs from public, anon, authenticated;
alter table public.integration_logs enable row level security;

revoke all on table public.shopee_webhook_events from public, anon, authenticated;
alter table public.shopee_webhook_events enable row level security;

revoke all on table public.shopee_orders from public, anon, authenticated;
alter table public.shopee_orders enable row level security;

-- Historico interno do Prisma Migrate. Permanece acessivel ao owner postgres.
revoke all on table public._prisma_migrations from public, anon, authenticated;
alter table public._prisma_migrations enable row level security;
