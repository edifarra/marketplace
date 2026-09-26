import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/093_harden_service_only_products_inventory.sql";
const sql = fs.readFileSync(path.join(root, migrationPath), "utf8").toLowerCase();
const migrationDirectory = path.join(root, "supabase/migrations");
const historicalSql = fs.readdirSync(migrationDirectory)
  .filter((file) => file.endsWith(".sql") && file < "093_harden_service_only_products_inventory.sql")
  .sort()
  .map((file) => fs.readFileSync(path.join(migrationDirectory, file), "utf8").toLowerCase())
  .join("\n");
const tables = [
  "products", "product_images", "product_marketplaces", "product_marketplace_variations",
  "listings", "estoque", "estoque_movimentacao", "venda_estoque_auditoria",
  "marketplace_category_mappings", "config_types", "config_brands", "config_specials"
];

test("lote 2 habilita RLS e remove acesso publico, anonimo e autenticado", () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security\\s*;`), table);
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated(?:\\s*,\\s*service_role)?\\s*;`), table);
  }
  assert.doesNotMatch(sql, /create\s+policy|alter\s+policy/);
  assert.doesNotMatch(sql, /grant\s+[^;]+\s+to\s+(?:public|anon|authenticated)\s*;/);
});

test("lote 2 concede privilegios explicitos e minimos ao service_role", () => {
  for (const table of [
    "products", "product_images", "product_marketplaces", "product_marketplace_variations",
    "listings", "estoque", "marketplace_category_mappings", "config_types", "config_brands", "config_specials"
  ]) {
    assert.match(sql, new RegExp(`grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role\\s*;`), table);
  }
  assert.match(sql, /grant\s+select\s+on\s+table\s+public\.estoque_movimentacao\s+to\s+service_role\s*;/);
  assert.match(sql, /grant\s+select\s*,\s*delete\s+on\s+table\s+public\.venda_estoque_auditoria\s+to\s+service_role\s*;/);
  assert.doesNotMatch(sql, /grant\s+all\s+on\s+(?:table|function|sequence)/);
});

test("view de produtos permanece security-invoker e service-only", () => {
  const viewMigration = fs.readFileSync(path.join(root, "supabase/migrations/066_products_available_stock_filter.sql"), "utf8").toLowerCase();
  assert.match(viewMigration, /create\s+view\s+public\.products_with_link_type\s+with\s*\(security_invoker\s*=\s*true\)/);
  assert.match(sql, /revoke\s+all\s+on\s+table\s+public\.products_with_link_type\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/);
  assert.match(sql, /grant\s+select\s+on\s+table\s+public\.products_with_link_type\s+to\s+service_role\s*;/);
});

test("RPCs administrativas de produto e estoque sao service-only", () => {
  const signatures = [
    "set_physical_inventory\\(uuid,\\s*integer\\)",
    "set_physical_inventory_manual\\(uuid,\\s*integer,\\s*uuid,\\s*text\\)",
    "reconcile_sale_inventory\\(uuid,\\s*boolean,\\s*boolean,\\s*boolean\\)",
    "audit_sale_inventory\\(uuid\\)", "list_product_statuses\\(\\)",
    "sync_product_marketplace_metadata\\(uuid,\\s*jsonb,\\s*jsonb\\)",
    "replace_product_images_atomically\\(uuid,\\s*jsonb\\)"
  ];
  for (const signature of signatures) {
    assert.match(sql, new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`), signature);
    assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+to\\s+service_role\\s*;`), signature);
  }
});

test("funcoes endurecidas existem no estado historico anterior a 093", () => {
  const functions = [
    ["set_physical_inventory", "(?:p_product_id\\s+)?uuid\\s*,\\s*(?:p_quantity\\s+)?integer"],
    ["set_physical_inventory_manual", "(?:p_product_id\\s+)?uuid\\s*,\\s*(?:p_quantity\\s+)?integer\\s*,\\s*(?:p_actor_user_id\\s+)?uuid\\s*,\\s*(?:p_actor_name\\s+)?text"],
    ["reconcile_sale_inventory", "(?:p_sale_id\\s+)?uuid\\s*,\\s*(?:p_reserve\\s+)?boolean\\s*,\\s*(?:p_release\\s+)?boolean\\s*,\\s*(?:p_deduct_physical\\s+)?boolean"],
    ["audit_sale_inventory", "(?:p_sale_id\\s+)?uuid"],
    ["list_product_statuses", ""],
    ["sync_product_marketplace_metadata", "(?:p_product_id\\s+)?uuid\\s*,\\s*(?:p_categories\\s+)?jsonb\\s*,\\s*(?:p_attributes\\s+)?jsonb"],
    ["replace_product_images_atomically", "(?:p_product_id\\s+)?uuid\\s*,\\s*(?:p_images\\s+)?jsonb"],
    ["ensure_product_inventory", ""],
    ["mirror_available_stock_to_product", ""],
    ["increment_stock_version", ""],
    ["prevent_linked_product_category_change", ""],
    ["enforce_final_marketplace_unlink", ""],
    ["block_final_listing_link", ""]
  ];

  for (const [name, parameters] of functions) {
    const createPattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${name}\\s*\\(\\s*${parameters}\\s*\\)`, "g");
    const dropPattern = new RegExp(`drop\\s+function(?:\\s+if\\s+exists)?\\s+(?:public\\.)?${name}\\s*\\(`, "g");
    const createOffsets = [...historicalSql.matchAll(createPattern)].map((match) => match.index);
    const dropOffsets = [...historicalSql.matchAll(dropPattern)].map((match) => match.index);
    const lastCreate = createOffsets.at(-1) ?? -1;
    const lastDrop = dropOffsets.at(-1) ?? -1;

    assert.notEqual(lastCreate, -1, `${name}: assinatura esperada nao foi criada`);
    assert.ok(lastCreate > lastDrop, `${name}: funcao foi removida depois da ultima criacao`);
  }
});

test("093 nao referencia diretamente a funcao obsoleta set_estoque_disponivel", () => {
  assert.match(historicalSql, /drop\s+function\s+if\s+exists\s+set_estoque_disponivel\s*\(\s*\)\s*;/);
  assert.doesNotMatch(sql, /(?:revoke|grant)\s+[^;]*\bset_estoque_disponivel\s*\(/);
});

test("sequences dependentes ficam protegidas sem incluir objetos de lotes futuros", () => {
  assert.match(sql, /pg_get_serial_sequence/);
  assert.match(sql, /revoke all on sequence %s from public, anon, authenticated/);
  assert.match(sql, /grant usage, select, update on sequence %s to service_role/);
  for (const excluded of ["venda", "venda_item", "marketplace_activities", "pipeline_runs", "telegram_notification_jobs"]) {
    assert.doesNotMatch(sql, new RegExp(`\\('(?:public\\.)?${excluded}'\\)`), excluded);
  }
});
