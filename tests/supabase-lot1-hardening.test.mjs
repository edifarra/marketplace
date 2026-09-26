import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/092_harden_service_only_core_configuration.sql";
const sql = fs.readFileSync(path.join(root, migrationPath), "utf8").toLowerCase();
const tables = [
  "settings",
  "app_users",
  "sku_counters",
  "config_marketplace_accounts",
  "config_marketplaces"
];

test("lote 1 habilita RLS e remove acesso publico, anonimo e autenticado", () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security\\s*;`), table);
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`), table);
  }
});

test("lote 1 concede ao service_role somente as operacoes usadas", () => {
  const expectedGrants = new Map([
    ["settings", "select, insert, update, delete"],
    ["app_users", "select, insert, update"],
    ["sku_counters", "select, insert, update"],
    ["config_marketplace_accounts", "select, insert, update, delete"],
    ["config_marketplaces", "select"]
  ]);

  for (const [table, privileges] of expectedGrants) {
    assert.match(sql, new RegExp(`grant\\s+${privileges.replaceAll(", ", "\\s*,\\s*")}\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role\\s*;`), table);
  }
  assert.doesNotMatch(sql, /grant\s+all\s+on\s+table/);
});

test("view e funcao relacionadas nao ficam expostas como API publica", () => {
  assert.match(sql, /revoke\s+all\s+on\s+table\s+public\.marketplace_accounts\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/);
  assert.match(sql, /grant\s+select\s+on\s+table\s+public\.marketplace_accounts\s+to\s+service_role\s*;/);
  assert.match(sql, /revoke\s+execute\s+on\s+function\s+public\.set_app_users_updated_at\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/);
});

test("lote 1 nao cria policies nem inclui tabelas dos lotes seguintes", () => {
  assert.doesNotMatch(sql, /create\s+policy|alter\s+policy/);
  for (const excluded of [
    "products",
    "product_images",
    "listings",
    "estoque",
    "vendas",
    "marketplace_activity_queue",
    "marketplace_conversations"
  ]) {
    assert.doesNotMatch(sql, new RegExp(`(?:table|on)\\s+public\\.${excluded}\\b`), excluded);
  }
});
