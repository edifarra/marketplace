-- Lote 2 do hardening: catalogo, imagens, anuncios e estoque apenas no backend.
-- O service_role ignora RLS, mas os grants explicitos documentam e limitam a API.

alter table public.products enable row level security;
revoke all on table public.products from public, anon, authenticated;
grant select, insert, update, delete on table public.products to service_role;

alter table public.product_images enable row level security;
revoke all on table public.product_images from public, anon, authenticated;
grant select, insert, update, delete on table public.product_images to service_role;

alter table public.product_marketplaces enable row level security;
revoke all on table public.product_marketplaces from public, anon, authenticated;
grant select, insert, update, delete on table public.product_marketplaces to service_role;

-- Complementa o hardening parcial da migration 061 e remove o grant ALL.
alter table public.product_marketplace_variations enable row level security;
revoke all on table public.product_marketplace_variations from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.product_marketplace_variations to service_role;

alter table public.listings enable row level security;
revoke all on table public.listings from public, anon, authenticated;
grant select, insert, update, delete on table public.listings to service_role;

alter table public.estoque enable row level security;
revoke all on table public.estoque from public, anon, authenticated;
grant select, insert, update, delete on table public.estoque to service_role;

-- A migration 029 desabilitou o RLS enquanto o servidor ainda usava anon.
-- Desde a Etapa 2 todo acesso do runtime usa service_role, portanto ele pode
-- ser reativado sem policy publica. Escritas normais ocorrem pelas RPCs abaixo.
alter table public.estoque_movimentacao enable row level security;
revoke all on table public.estoque_movimentacao from public, anon, authenticated;
grant select on table public.estoque_movimentacao to service_role;

-- A migration 032 seguiu o mesmo modelo legado sem RLS. O runtime le e remove
-- auditorias obsoletas; audit_sale_inventory faz os upserts como definer.
alter table public.venda_estoque_auditoria enable row level security;
revoke all on table public.venda_estoque_auditoria from public, anon, authenticated;
grant select, delete on table public.venda_estoque_auditoria to service_role;

alter table public.marketplace_category_mappings enable row level security;
revoke all on table public.marketplace_category_mappings from public, anon, authenticated;
grant select, insert, update, delete on table public.marketplace_category_mappings to service_role;

alter table public.config_types enable row level security;
revoke all on table public.config_types from public, anon, authenticated;
grant select, insert, update, delete on table public.config_types to service_role;

alter table public.config_brands enable row level security;
revoke all on table public.config_brands from public, anon, authenticated;
grant select, insert, update, delete on table public.config_brands to service_role;

alter table public.config_specials enable row level security;
revoke all on table public.config_specials from public, anon, authenticated;
grant select, insert, update, delete on table public.config_specials to service_role;

-- View security_invoker criada pela migration 066: o chamador tambem precisa
-- de acesso service_role a products, listings, product_marketplaces e estoque.
revoke all on table public.products_with_link_type from public, anon, authenticated;
grant select on table public.products_with_link_type to service_role;

-- RPCs chamadas pelo runtime/worker. As funcoes de estoque que sao SECURITY
-- DEFINER mantem o comportamento atomico atual, mas deixam de ser RPCs publicas.
revoke execute on function public.set_physical_inventory(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_physical_inventory(uuid, integer) to service_role;

revoke execute on function public.set_physical_inventory_manual(uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.set_physical_inventory_manual(uuid, integer, uuid, text) to service_role;

revoke execute on function public.reconcile_sale_inventory(uuid, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.reconcile_sale_inventory(uuid, boolean, boolean, boolean) to service_role;

revoke execute on function public.audit_sale_inventory(uuid) from public, anon, authenticated;
grant execute on function public.audit_sale_inventory(uuid) to service_role;

revoke execute on function public.list_product_statuses() from public, anon, authenticated;
grant execute on function public.list_product_statuses() to service_role;

revoke execute on function public.sync_product_marketplace_metadata(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sync_product_marketplace_metadata(uuid, jsonb, jsonb) to service_role;

revoke execute on function public.replace_product_images_atomically(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_product_images_atomically(uuid, jsonb) to service_role;

-- Funcoes internas de triggers nao devem ser invocaveis pela API.
-- Assinaturas conferidas contra o estado final das migrations 009-091.
-- set_estoque_disponivel() nao faz parte desta lista: a migration 019 removeu
-- definitivamente a funcao e seu trigger ao separar estoque fisico e reserva.
revoke execute on function public.ensure_product_inventory() from public, anon, authenticated;
revoke execute on function public.mirror_available_stock_to_product() from public, anon, authenticated;
revoke execute on function public.increment_stock_version() from public, anon, authenticated;
revoke execute on function public.prevent_linked_product_category_change() from public, anon, authenticated;
revoke execute on function public.enforce_final_marketplace_unlink() from public, anon, authenticated;
revoke execute on function public.block_final_listing_link() from public, anon, authenticated;

-- As tabelas atuais usam UUID e nao possuem sequences. Ainda assim, protege de
-- forma explicita qualquer sequence serial/identity efetivamente vinculada a
-- uma coluna do escopo, sem atingir sequences reservadas aos lotes futuros.
do $$
declare
  sequence_name text;
begin
  for sequence_name in
    select distinct pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name)
      from information_schema.columns
      join (values
        ('products'), ('product_images'), ('product_marketplaces'),
        ('product_marketplace_variations'), ('listings'), ('estoque'),
        ('estoque_movimentacao'), ('venda_estoque_auditoria'),
        ('marketplace_category_mappings'), ('config_types'), ('config_brands'),
        ('config_specials')
      ) scoped_tables(table_name) using (table_name)
     where columns.table_schema = 'public'
       and pg_get_serial_sequence(format('%I.%I', columns.table_schema, columns.table_name), columns.column_name) is not null
  loop
    execute format('revoke all on sequence %s from public, anon, authenticated', sequence_name);
    execute format('grant usage, select, update on sequence %s to service_role', sequence_name);
  end loop;
end;
$$;
