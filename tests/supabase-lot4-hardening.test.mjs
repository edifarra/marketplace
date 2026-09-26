import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase/migrations");
const migrationName = "095_harden_service_only_auxiliary_infrastructure.sql";
const sql = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8").toLowerCase();
const migrationFiles = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql")).sort();
const historicalSql = migrationFiles.filter((file) => file < migrationName)
  .map((file) => fs.readFileSync(path.join(migrationDirectory, file), "utf8").toLowerCase()).join("\n");

const lot1 = ["settings", "app_users", "sku_counters", "config_marketplace_accounts", "config_marketplaces"];
const lot2 = [
  "products", "product_images", "product_marketplaces", "product_marketplace_variations",
  "listings", "estoque", "estoque_movimentacao", "venda_estoque_auditoria",
  "marketplace_category_mappings", "config_types", "config_brands", "config_specials"
];
const lot3 = [
  "venda", "venda_item", "status_venda", "marketplace_activities", "marketplace_activity_history",
  "outgoing_marketplace_activities", "outgoing_marketplace_activity_history",
  "marketplace_conversations", "marketplace_conversation_messages", "marketplace_listing_moderations"
];
const lot4 = [
  "orders", "pipeline_runs", "pipeline_logs", "tiny_sync_items", "migration_stock_logs",
  "price_search_cache", "price_search_debug_results", "google_drive_folders",
  "telegram_notification_config", "telegram_notification_history", "telegram_notification_jobs",
  "deletion_audit_logs"
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tablePattern = (prefix, table, suffix) => new RegExp(`${prefix}public\\.${escapeRegex(table)}${suffix}`);

test("lote 4 habilita RLS e remove acesso publico de toda tabela auxiliar", () => {
  for (const table of lot4) {
    assert.match(sql, tablePattern("alter\\s+table\\s+", table, "\\s+enable\\s+row\\s+level\\s+security\\s*;"), table);
    assert.match(sql, tablePattern("revoke\\s+all\\s+on\\s+table\\s+", table, "\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role\\s*;"), table);
  }
  assert.doesNotMatch(sql, /create\s+policy|alter\s+policy/);
  assert.doesNotMatch(sql, /grant\s+[^;]+\s+to\s+(?:public|anon|authenticated)\s*;/);
  assert.doesNotMatch(sql, /grant\s+all\s+on\s+(?:table|function|sequence)/);
});

test("grants do service_role preservam apenas as operacoes usadas", () => {
  for (const table of ["orders", "pipeline_runs", "pipeline_logs", "tiny_sync_items", "google_drive_folders"]) {
    assert.match(sql, tablePattern("grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+table\\s+", table, "\\s+to\\s+service_role\\s*;"), table);
  }
  for (const table of ["migration_stock_logs", "price_search_cache"]) {
    assert.match(sql, tablePattern("grant\\s+select\\s*,\\s*insert\\s+on\\s+table\\s+", table, "\\s+to\\s+service_role\\s*;"), table);
  }
  assert.match(sql, /grant\s+select\s*,\s*insert\s*,\s*delete\s+on\s+table\s+public\.price_search_debug_results\s+to\s+service_role\s*;/);
  assert.match(sql, /grant\s+select\s*,\s*update\s+on\s+table\s+public\.telegram_notification_config\s+to\s+service_role\s*;/);
  for (const table of ["telegram_notification_history", "telegram_notification_jobs"]) {
    assert.match(sql, tablePattern("grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s+on\\s+table\\s+", table, "\\s+to\\s+service_role\\s*;"), table);
  }
  assert.match(sql, /grant\s+select\s+on\s+table\s+public\.deletion_audit_logs\s+to\s+service_role\s*;/);
});

test("cache de preco reverte explicitamente o RLS desabilitado na 029", () => {
  assert.match(historicalSql, /alter\s+table\s+price_search_cache\s+disable\s+row\s+level\s+security\s*;/);
  assert.match(sql, /alter\s+table\s+public\.price_search_cache\s+enable\s+row\s+level\s+security\s*;/);
  assert.match(sql, /alter\s+table\s+public\.price_search_debug_results\s+enable\s+row\s+level\s+security\s*;/);
});

test("funcao SECURITY DEFINER de auditoria existe e nao e RPC publica", () => {
  const creates = [...historicalSql.matchAll(/create\s+or\s+replace\s+function\s+(?:public\.)?audit_deleted_record\s*\(\s*\)/g)];
  const drops = [...historicalSql.matchAll(/drop\s+function(?:\s+if\s+exists)?\s+(?:public\.)?audit_deleted_record\s*\(/g)];
  assert.ok(creates.length > 0);
  assert.ok((creates.at(-1)?.index ?? -1) > (drops.at(-1)?.index ?? -1));
  assert.match(historicalSql, /create\s+or\s+replace\s+function\s+(?:public\.)?audit_deleted_record\s*\(\s*\)[\s\S]*?returns\s+trigger[\s\S]*?security\s+definer/);
  assert.match(sql, /revoke\s+execute\s+on\s+function\s+public\.audit_deleted_record\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/);
  assert.doesNotMatch(sql, /grant\s+execute\s+on\s+function\s+public\.audit_deleted_record/);
});

test("sequences dependentes sao protegidas explicitamente", () => {
  assert.match(sql, /pg_get_serial_sequence/);
  assert.match(sql, /revoke all on sequence %s from public, anon, authenticated, service_role/);
  assert.match(sql, /grant usage, select, update on sequence %s to service_role/);
  assert.match(historicalSql, /price_search_debug_results[\s\S]*?id\s+bigint\s+generated\s+by\s+default\s+as\s+identity/);
  for (const table of lot4) assert.match(sql, new RegExp(`\\('${escapeRegex(table)}'\\)`), table);
});

test("inventario final classifica todas as tabelas public criadas ate a 095", () => {
  const createdTables = new Set([...historicalSql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/g)]
    .map((match) => match[1]));
  const classifiedTables = [...lot1, ...lot2, ...lot3, ...lot4];
  assert.deepEqual([...createdTables].sort(), [...classifiedTables].sort());
  assert.equal(new Set(classifiedTables).size, classifiedTables.length, "tabela classificada em mais de um lote");

  for (const [migration, tables] of [
    ["092_harden_service_only_core_configuration.sql", lot1],
    ["093_harden_service_only_products_inventory.sql", lot2],
    ["094_harden_service_only_sales_activities_conversations.sql", lot3],
    [migrationName, lot4]
  ]) {
    const migrationSql = fs.readFileSync(path.join(migrationDirectory, migration), "utf8").toLowerCase();
    for (const table of tables) {
      assert.match(migrationSql, tablePattern("alter\\s+table\\s+", table, "\\s+enable\\s+row\\s+level\\s+security\\s*;"), `${migration}: ${table}`);
      assert.match(migrationSql, tablePattern("revoke\\s+all\\s+on\\s+table\\s+", table, "\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated(?:\\s*,\\s*service_role)?\\s*;"), `${migration}: ${table}`);
    }
  }
});

test("as duas views public conhecidas ja estao cobertas pelos lotes anteriores", () => {
  const views = new Set([...historicalSql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+/g)]
    .map((match) => match[1]));
  assert.deepEqual([...views].sort(), ["marketplace_accounts", "products_with_link_type"]);
  assert.match(fs.readFileSync(path.join(migrationDirectory, "092_harden_service_only_core_configuration.sql"), "utf8").toLowerCase(), /revoke\s+all\s+on\s+table\s+public\.marketplace_accounts/);
  assert.match(fs.readFileSync(path.join(migrationDirectory, "093_harden_service_only_products_inventory.sql"), "utf8").toLowerCase(), /revoke\s+all\s+on\s+table\s+public\.products_with_link_type/);
});

test("consumidores do lote 4 usam o cliente administrativo", () => {
  for (const relativePath of [
    "app/api/pipeline/run/route.ts", "app/api/pipeline/products/route.ts",
    "app/api/retention/cleanup/route.ts", "app/api/google/oauth/callback/route.ts",
    "app/logs/page.tsx", "app/page.tsx", "lib/google-drive-config.ts",
    "lib/marketplace-account-logs.ts", "lib/migration-stock.ts", "lib/price-evaluation.ts",
    "lib/product-point-sync.ts", "lib/products.ts", "lib/synchronization-logs.ts",
    "lib/telegram-notifications.ts", "lib/tiny-stock-sync.ts"
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.match(source, /supabaseAdmin\s*\(/, relativePath);
    assert.doesNotMatch(source, /NEXT_PUBLIC_SUPABASE_ANON_KEY/, relativePath);
  }
});
