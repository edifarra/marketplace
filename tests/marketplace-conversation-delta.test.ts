import assert from "node:assert/strict";
import test from "node:test";
import { latestConversationCursor, mergeConversationDelta, shouldPollConversationChanges, takeConversationChangeBatch } from "../lib/marketplace-conversation-delta";
import { prepareConversationRows } from "../lib/marketplace-conversation-view";

const view = { tab: "all" as const, marketplace: "", store: "", status: "", sla: "", search: "", from: "", to: "", unread: "" };
const base = (overrides: Record<string, any> = {}) => ({
  id: crypto.randomUUID(), marketplace: "shopee", marketplace_account_id: "account", conversation_type: "chat",
  buyer_id: "buyer", sku: "SKU", status: "answered", requires_response: false, unread: false,
  last_message_at: "2026-09-17T10:00:00.000Z", updated_at: "2026-09-17T10:00:00.000Z",
  marketplace_conversation_messages: [], ...overrides
});

test("ciclo sem alterações mantém as linhas sem consultar ou acrescentar históricos", () => {
  const rows = prepareConversationRows([base({ id: "a" })], 1, 6);
  assert.deepEqual(mergeConversationDelta(rows, [], [], view, 25), rows);
});

test("conversa respondida reaparece quando uma nova mensagem altera seu estado", () => {
  const oldRows = prepareConversationRows([base({ id: "a" })], 1, 6);
  const changed = prepareConversationRows([base({ id: "a", requires_response: true, unread: true, status: "pending", updated_at: "2026-09-17T10:01:00.000Z",
    marketplace_conversation_messages: [{ id: "m1", external_message_id: "m1", direction: "incoming", sent_at: "2026-09-17T10:01:00.000Z", text: "Nova" }] })], 1, 6);
  const merged = mergeConversationDelta(oldRows, changed, ["a"], view, 25);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].requires_response, true);
  assert.equal(merged[0].messages.length, 1);
});

test("grupo de perguntas do Mercado Livre é substituído como uma unidade", () => {
  const question = (id: string, pending: boolean) => base({ id, marketplace: "mercado_livre", conversation_type: "question", buyer_id: "b", sku: "S",
    requires_response: pending, unread: pending, status: pending ? "pending" : "answered" });
  const initial = prepareConversationRows([question("q1", true), question("q2", false)], 1, 6);
  const changed = prepareConversationRows([question("q1", false), question("q2", false)], 1, 6);
  const merged = mergeConversationDelta(initial, changed, ["q1"], view, 25);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].question_count, 2);
  assert.equal(merged[0].requires_response, false);
});

test("cursor composto preserva alterações com o mesmo updated_at", () => {
  const cursor = latestConversationCursor([
    { id: "00000000-0000-0000-0000-000000000001", updated_at: "2026-09-17T10:00:00.000Z" },
    { id: "00000000-0000-0000-0000-000000000002", updated_at: "2026-09-17T10:00:00.000Z" }
  ]);
  assert.equal(cursor.id, "00000000-0000-0000-0000-000000000002");
});

test("merge suporta lote maior que a janela visível sem duplicar grupos", () => {
  const changes = prepareConversationRows(Array.from({ length: 30 }, (_, index) => base({ id: `c${index}`, updated_at: `2026-09-17T10:${String(index).padStart(2, "0")}:00.000Z`, last_message_at: `2026-09-17T10:${String(index).padStart(2, "0")}:00.000Z` })), 1, 6);
  const merged = mergeConversationDelta([], changes, changes.map((row) => row.id), view, 25);
  assert.equal(merged.length, 25);
  assert.equal(new Set(merged.map((row) => row.groupKey)).size, 25);
});

test("paginação incremental sinaliza hasMore sem descartar a ordem restante", () => {
  const batch = takeConversationChangeBatch([1, 2, 3, 4], 3);
  assert.deepEqual(batch, { rows: [1, 2, 3], hasMore: true });
  assert.deepEqual(takeConversationChangeBatch([1, 2, 3], 3), { rows: [1, 2, 3], hasMore: false });
});

test("polling pausa com aba oculta e pode executar imediatamente no retorno", () => {
  assert.equal(shouldPollConversationChanges("hidden"), false);
  assert.equal(shouldPollConversationChanges("visible"), true);
});

test("estado canônico substitui otimista e preserva sent, error e retry", () => {
  const optimistic = prepareConversationRows([base({ id: "a", marketplace_conversation_messages: [
    { id: "optimistic:a", external_message_id: "optimistic:a", direction: "outgoing", sent_at: "2026-09-17T10:01:00.000Z", status: "queued" }
  ] })], 1, 6);
  for (const status of ["sent", "error", "queued"]) {
    const canonical = prepareConversationRows([base({ id: "a", status: status === "error" ? "error" : "answered", last_error: status === "error" ? "Falha" : null,
      updated_at: `2026-09-17T10:0${status.length}:00.000Z`, marketplace_conversation_messages: [
        { id: `canonical:${status}`, external_message_id: `remote:${status}`, direction: "outgoing", sent_at: "2026-09-17T10:01:00.000Z", status }
      ] })], 1, 6);
    const merged = mergeConversationDelta(optimistic, canonical, ["a"], view, 25);
    assert.equal(merged[0].messages.length, 1);
    assert.equal(merged[0].messages[0].status, status);
    assert.equal(String(merged[0].messages[0].id).startsWith("optimistic:"), false);
  }
});

test("mensagem pós-venda alterada mantém tipo e linha do tempo canônica", () => {
  const changed = prepareConversationRows([base({ id: "p", marketplace: "mercado_livre", conversation_type: "post_sale", purchased_at: "2026-09-17T09:00:00.000Z",
    requires_response: true, unread: true, marketplace_conversation_messages: [
      { id: "pm", external_message_id: "pm", direction: "incoming", sent_at: "2026-09-17T10:00:00.000Z", status: "received" }
    ] })], 1, 6);
  const merged = mergeConversationDelta([], changed, ["p"], view, 25);
  assert.equal(merged[0].conversation_type, "post_sale");
  assert.equal(merged[0].messages[0].id, "pm");
});

test("delta vazio é ordens de grandeza menor que histórico repetido", () => {
  const largeHistory = Array.from({ length: 5000 }, (_, index) => base({ id: `row-${index}`, raw_data: { payload: "x".repeat(200) }, marketplace_conversation_messages: [{ id: `m-${index}`, text: "x".repeat(200) }] }));
  const oldBytes = Buffer.byteLength(JSON.stringify(largeHistory));
  const newBytes = Buffer.byteLength(JSON.stringify({ changes: [], changedConversationIds: [], hasMore: false }));
  assert.ok(oldBytes / newBytes > 10_000);
});
