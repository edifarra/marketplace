import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MESSAGE_SNAPSHOT_SELECT,
  MarketplaceMessageSnapshot,
  MarketplaceMessageWrite,
  marketplaceConversationChanged,
  marketplaceMessageChanged,
  planMarketplaceMessageWrites
} from "../lib/marketplace-message-reconciliation";

const conversationId = "00000000-0000-4000-8000-000000000001";

function message(index: number, overrides: Partial<MarketplaceMessageWrite> = {}): MarketplaceMessageWrite {
  return {
    conversation_id: conversationId,
    external_message_id: `message-${index}`,
    direction: index % 2 ? "incoming" : "outgoing",
    message_type: "text",
    text: `Mensagem ${index}`,
    sender_id: index % 2 ? `buyer-${index}` : "shop-1",
    sender_name: index % 2 ? "Cliente" : "Loja",
    sent_at: new Date(Date.UTC(2026, 8, 17, 20, 0, index)).toISOString(),
    status: index % 2 ? "received" : "sent",
    raw_data: { message_id: `message-${index}`, content: { text: `Mensagem ${index}` } },
    marketplace_account_id: null,
    external_message_key: null,
    ...overrides
  };
}

function snapshot(value: MarketplaceMessageWrite): MarketplaceMessageSnapshot {
  return {
    id: `row-${value.external_message_id}`,
    ...value,
    raw_data: undefined,
    raw_content: value.raw_data.content,
    raw_source_content: value.raw_data.source_content,
    raw_image_url: value.raw_data.image_url,
    raw_url: value.raw_data.url,
    raw_message_type: value.raw_data.message_type,
    raw_type: value.raw_data.type
  };
}

test("Shopee com 50 mensagens existentes e idênticas produz zero writes", () => {
  const desired = Array.from({ length: 50 }, (_, index) => message(index));
  const plan = planMarketplaceMessageWrites(desired, desired.map(snapshot));
  assert.equal(plan.inserted.length, 0);
  assert.equal(plan.updated.length, 0);
  assert.equal(plan.unchanged.length, 50);
});

test("snapshot PostgREST inclui conversation_id e detecta identidade inconsistente", () => {
  assert.ok(MESSAGE_SNAPSHOT_SELECT.split(",").includes("conversation_id"));
  const desired = message(1);
  const existing = snapshot(desired);
  assert.equal(marketplaceMessageChanged(existing, desired), false);
  assert.equal(marketplaceMessageChanged({ ...existing, conversation_id: undefined }, desired), true);
  assert.equal(marketplaceMessageChanged({ ...existing, conversation_id: "outra-conversa" }, desired), true);
  assert.equal(marketplaceMessageChanged(existing, { ...desired, text: "Texto realmente alterado" }), true);
});

test("49 mensagens idênticas e uma nova persistem somente a nova", () => {
  const desired = Array.from({ length: 50 }, (_, index) => message(index));
  const plan = planMarketplaceMessageWrites(desired, desired.slice(0, 49).map(snapshot));
  assert.deepEqual(plan.inserted.map(row => row.external_message_id), ["message-49"]);
  assert.equal(plan.updated.length, 0);
  assert.equal(plan.unchanged.length, 49);
});

test("mensagem existente realmente alterada atualiza somente ela", () => {
  const original = Array.from({ length: 5 }, (_, index) => message(index));
  const desired = original.map((row, index) => index === 2 ? message(index, { text: "Texto corrigido" }) : row);
  const plan = planMarketplaceMessageWrites(desired, original.map(snapshot));
  assert.equal(plan.inserted.length, 0);
  assert.deepEqual(plan.updated.map(row => row.external_message_id), ["message-2"]);
  assert.equal(plan.unchanged.length, 4);
});

test("múltiplas mensagens novas ficam em um único lote de inserts", () => {
  const desired = Array.from({ length: 8 }, (_, index) => message(index));
  const plan = planMarketplaceMessageWrites(desired, desired.slice(0, 3).map(snapshot));
  assert.deepEqual(plan.inserted.map(row => row.external_message_id), ["message-3", "message-4", "message-5", "message-6", "message-7"]);
  assert.equal(plan.updated.length, 0);
});

test("diferenças irrelevantes fora da projeção canônica de raw_data são ignoradas", () => {
  const desired = message(1, { raw_data: { content: { text: "Mensagem 1" }, volatile_trace: "novo" } });
  const existing = snapshot(message(1, { raw_data: { content: { text: "Mensagem 1" }, volatile_trace: "antigo" } }));
  assert.equal(marketplaceMessageChanged(existing, desired), false);
});

test("alteração de anexo usado pela tela é considerada mudança real", () => {
  const existing = snapshot(message(1, { raw_data: { content: { image_url: "https://old.example/image.jpg" } } }));
  const desired = message(1, { raw_data: { content: { image_url: "https://new.example/image.jpg" } } });
  assert.equal(marketplaceMessageChanged(existing, desired), true);
});

test("conversa idêntica não muda updated_at nem gera falso delta", () => {
  const existing = { status: "pending", requires_response: true, unread: true, last_message_at: "2026-09-17T20:00:00+00:00", last_message_preview: "Oi" };
  const desired = { status: "pending", requires_response: true, unread: true, last_message_at: "2026-09-17T20:00:00.000Z", last_message_preview: "Oi" };
  assert.equal(marketplaceConversationChanged(existing, desired), false);
});

test("mudança somente em estado relevante atualiza a conversa", () => {
  const existing = { status: "pending", requires_response: true, unread: true, last_message_at: "2026-09-17T20:00:00Z", last_message_preview: "Oi" };
  const desired = { ...existing, status: "answered", requires_response: false, unread: false };
  assert.equal(marketplaceConversationChanged(existing, desired), true);
});

test("ML pós-venda idêntico não executa UPDATE e alteração legítima executa", () => {
  const desired = message(1, { marketplace_account_id: "account-1", external_message_key: "ml-message:1" });
  const existing = snapshot(desired);
  assert.equal(marketplaceMessageChanged(existing, desired), false);
  assert.equal(marketplaceMessageChanged(existing, { ...desired, status: "sent", text: "Correção legítima" }), true);
});

test("migration 090 preserva INSERT/UPDATE/DELETE e ignora UPDATE idêntico", () => {
  const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/090_ignore_noop_message_updates.sql"), "utf8").toLowerCase();
  const originalTrigger = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/089_incremental_chat_screen_updates.sql"), "utf8").toLowerCase();
  assert.match(originalTrigger, /after insert or update or delete/);
  assert.match(migration, /tg_op = 'update' and new is not distinct from old/);
  assert.match(migration, /update marketplace_conversations\s+set updated_at = clock_timestamp\(\)/);
  assert.match(migration, /tg_op = 'delete'/);
  assert.ok(migration.indexOf("new is not distinct from old") < migration.indexOf("update marketplace_conversations"));
});
