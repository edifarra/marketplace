import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationName = "094_harden_service_only_sales_activities_conversations.sql";
const migrationPath = path.join(root, "supabase/migrations", migrationName);
const sql = fs.readFileSync(migrationPath, "utf8").toLowerCase();
const migrationDirectory = path.join(root, "supabase/migrations");
const historicalSql = fs.readdirSync(migrationDirectory)
  .filter((file) => file.endsWith(".sql") && file < migrationName)
  .sort()
  .map((file) => fs.readFileSync(path.join(migrationDirectory, file), "utf8").toLowerCase())
  .join("\n");

const tables = [
  "venda", "venda_item", "status_venda", "marketplace_activities",
  "marketplace_activity_history", "outgoing_marketplace_activities",
  "outgoing_marketplace_activity_history", "marketplace_conversations",
  "marketplace_conversation_messages", "marketplace_listing_moderations"
];

test("lote 3 habilita RLS e remove acesso publico, anonimo e autenticado", () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security\\s*;`), table);
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`), table);
  }
  assert.doesNotMatch(sql, /create\s+policy|alter\s+policy/);
  assert.doesNotMatch(sql, /grant\s+[^;]+\s+to\s+(?:public|anon|authenticated)\s*;/);
});

test("lote 3 concede privilegios explicitos e minimos ao service_role", () => {
  for (const table of [
    "venda", "venda_item", "marketplace_activities", "outgoing_marketplace_activities",
    "marketplace_conversations", "marketplace_conversation_messages", "marketplace_listing_moderations"
  ]) {
    assert.match(sql, new RegExp(`grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role\\s*;`), table);
  }
  assert.match(sql, /grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+table\s+public\.status_venda\s+to\s+service_role\s*;/);
  for (const table of ["marketplace_activity_history", "outgoing_marketplace_activity_history"]) {
    assert.match(sql, new RegExp(`grant\\s+select\\s*,\\s*insert\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role\\s*;`), table);
  }
  assert.doesNotMatch(sql, /grant\s+all\s+on\s+(?:table|function|sequence)/);
});

test("RPCs de vendas, filas e conversas sao service-only", () => {
  const signatures = [
    "claim_marketplace_activity_queue\\(integer\\)",
    "claim_outgoing_marketplace_activity_queue\\(integer\\)",
    "requeue_outgoing_marketplace_activity\\(uuid,\\s*text\\)",
    "finalize_marketplace_conversation_reply\\(uuid,\\s*text,\\s*text,\\s*text,\\s*timestamptz,\\s*jsonb\\)",
    "reconcile_sale_inventory\\(uuid,\\s*boolean,\\s*boolean,\\s*boolean\\)",
    "audit_sale_inventory\\(uuid\\)",
    "set_physical_inventory\\(uuid,\\s*integer\\)",
    "set_physical_inventory_manual\\(uuid,\\s*integer,\\s*uuid,\\s*text\\)"
  ];
  for (const signature of signatures) {
    assert.match(sql, new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`), signature);
    assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+to\\s+service_role\\s*;`), signature);
  }
});

test("funcoes internas de trigger nao permanecem executaveis publicamente", () => {
  for (const signature of [
    "fill_marketplace_conversation_product\\(\\)",
    "reconcile_conversations_from_listing\\(\\)",
    "touch_marketplace_conversation_from_message\\(\\)"
  ]) {
    assert.match(sql, new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`), signature);
    assert.doesNotMatch(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}`), signature);
  }
});

test("todas as assinaturas endurecidas existem no estado anterior a 094", () => {
  const functions = [
    ["claim_marketplace_activity_queue", "(?:p_limit\\s+)?integer(?:\\s+default\\s+10)?"],
    ["claim_outgoing_marketplace_activity_queue", "(?:p_limit\\s+)?integer(?:\\s+default\\s+10)?"],
    ["requeue_outgoing_marketplace_activity", "(?:p_id\\s+)?uuid\\s*,\\s*(?:p_error\\s+)?text"],
    ["finalize_marketplace_conversation_reply", "(?:p_conversation_id\\s+)?uuid\\s*,\\s*(?:p_draft_id\\s+)?text\\s*,\\s*(?:p_external_message_id\\s+)?text\\s*,\\s*(?:p_text\\s+)?text\\s*,\\s*(?:p_sent_at\\s+)?timestamptz\\s*,\\s*(?:p_raw_data\\s+)?jsonb(?:\\s+default\\s+'\\{\\}'::jsonb)?"],
    ["reconcile_sale_inventory", "(?:p_sale_id\\s+)?uuid\\s*,\\s*(?:p_reserve\\s+)?boolean\\s*,\\s*(?:p_release\\s+)?boolean\\s*,\\s*(?:p_deduct_physical\\s+)?boolean"],
    ["audit_sale_inventory", "(?:p_sale_id\\s+)?uuid"],
    ["set_physical_inventory", "(?:p_product_id\\s+)?uuid\\s*,\\s*(?:p_quantity\\s+)?integer"],
    ["set_physical_inventory_manual", "(?:p_product_id\\s+)?uuid\\s*,\\s*(?:p_quantity\\s+)?integer\\s*,\\s*(?:p_actor_user_id\\s+)?uuid\\s*,\\s*(?:p_actor_name\\s+)?text"],
    ["fill_marketplace_conversation_product", ""],
    ["reconcile_conversations_from_listing", ""],
    ["touch_marketplace_conversation_from_message", ""]
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

test("SECURITY DEFINER relacionadas ficam cobertas e triggers nao viram RPCs", () => {
  for (const name of [
    "claim_marketplace_activity_queue", "claim_outgoing_marketplace_activity_queue",
    "requeue_outgoing_marketplace_activity", "finalize_marketplace_conversation_reply",
    "reconcile_sale_inventory", "audit_sale_inventory", "set_physical_inventory",
    "set_physical_inventory_manual"
  ]) {
    assert.match(historicalSql, new RegExp(`create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${name}[\\s\\S]*?security\\s+definer`), name);
  }
  for (const name of [
    "fill_marketplace_conversation_product", "reconcile_conversations_from_listing",
    "touch_marketplace_conversation_from_message"
  ]) {
    assert.match(historicalSql, new RegExp(`create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${name}\\s*\\([^)]*\\)\\s*returns\\s+trigger`), name);
  }
});

test("sequences dependentes ficam protegidas sem incluir tabelas de lotes futuros", () => {
  assert.match(sql, /pg_get_serial_sequence/);
  assert.match(sql, /revoke all on sequence %s from public, anon, authenticated/);
  assert.match(sql, /grant usage, select, update on sequence %s to service_role/);
  assert.match(historicalSql, /queue_position\s+bigint\s+generated\s+always\s+as\s+identity/);
  for (const excluded of [
    "pipeline_runs", "pipeline_logs", "tiny_sync_items", "migration_stock_logs",
    "price_search_cache", "google_drive_folders", "telegram_notification_jobs",
    "telegram_notification_events", "deletion_audit_logs"
  ]) {
    assert.doesNotMatch(sql, new RegExp(`\\('(?:public\\.)?${excluded}'\\)`), excluded);
  }
});
