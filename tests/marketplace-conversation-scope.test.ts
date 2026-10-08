import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertChatReplyChannel } from "../lib/marketplace-conversation-scope";
import { prepareConversationRows } from "../lib/marketplace-conversation-view";
import { latestConversationCursor, mergeConversationDelta, takeConversationChangeBatch } from "../lib/marketplace-conversation-delta";
import { safeClaimConversation, loadCaseDetail } from "../lib/marketplace-case-detail";
import { normalizeCase } from "../lib/marketplace-case-domain";

const view = { tab: "all" as const, marketplace: "", store: "", status: "", sla: "", search: "", from: "", to: "", unread: "" };
const normal = (overrides: Record<string, any> = {}) => ({ id: "normal", marketplace: "mercado_livre", marketplace_account_id: "account",
  conversation_type: "post_sale", external_conversation_id: "pack:1", order_id: "order", status: "answered",
  last_message_at: "2026-10-07T12:00:00Z", updated_at: "2026-10-07T12:00:00Z",
  messages: [{ id: "before", sent_at: "2026-10-06T12:00:00Z", text: "Chat anterior" },
    { id: "after", sent_at: "2026-10-07T12:00:00Z", text: "Chat normal posterior" }], ...overrides });
const claim = (overrides: Record<string, any> = {}) => normal({ id: "claim", conversation_type: "claim", external_conversation_id: "claim:1",
  messages: [{ id: "official", sent_at: "2026-10-07T10:00:00Z", text: "Mensagem oficial do caso" }], ...overrides });

test("normal chat without a claim keeps its complete history", () => {
  assert.deepEqual(prepareConversationRows([normal()], 1, 6)[0].messages, normal().messages);
});
for (const status of ["opened", "closed", "reopened"]) {
  test(`normal chat survives ${status} claim on the same order in initial load and repeated polling`, () => {
    const sources = [normal(), claim({ status, requires_response: status !== "closed" })];
    const rows = prepareConversationRows(sources, 1, 6);
    assert.deepEqual(rows.map(r => r.id), ["normal"]);
    let merged = rows;
    for (let i = 0; i < 3; i++) merged = mergeConversationDelta(merged, rows, ["normal", "claim"], view, 25);
    assert.deepEqual(merged.map(r => r.id), ["normal"]);
    assert.deepEqual(merged[0].messages.map(m => m.id), ["before", "after"]);
  });
}
test("polling removes a previously leaked case, advances its cursor and retains normal chat", () => {
  const rows = prepareConversationRows([normal()], 1, 6);
  const leaked = { ...rows[0], ...claim(), groupKey: "single:claim", grouped_conversation_ids: ["claim"] };
  const batch = takeConversationChangeBatch([claim({ updated_at: "2026-10-07T13:00:00Z" })], 100);
  assert.equal(latestConversationCursor(batch.rows).updatedAt, "2026-10-07T13:00:00Z");
  assert.deepEqual(mergeConversationDelta([...rows, leaked], [], ["claim"], view, 25).map(r => r.id), ["normal"]);
});
test("Shopee return event does not convert the buyer conversation, even when the same conversation ID is reused", () => {
  const event = normalizeCase({ id: "event", marketplace: "shopee", raw_payload: { code: 29, data: { return_sn: "R1", order_sn: "order" } } }, "account")!;
  assert.equal(event.case_type, "return");
  assert.equal(event.claim_messages, undefined);
  const chat = normal({ marketplace: "shopee", conversation_type: "chat", raw_data: { return_sn: "R1" } });
  assert.equal(prepareConversationRows([chat], 1, 6)[0].messages.length, 2);
  assert.doesNotThrow(() => assertChatReplyChannel(chat));
});
test("case association cannot cross accounts or select normal chats as its official channel", () => {
  assert.equal(safeClaimConversation([claim(), claim({ marketplace_account_id: "other" })], "account", "1")?.id, "claim");
  assert.equal(safeClaimConversation([normal(), claim({ marketplace_account_id: "other" })], "account", "1"), null);
  const rows = prepareConversationRows([normal(), normal({ id: "other", marketplace_account_id: "other" }), claim()], 1, 6);
  assert.equal(rows.length, 2);
});
test("reply channels reject claim and unknown types before creating a draft or sending, including legacy queued jobs", () => {
  for (const conversation_type of ["claim", "return", "unknown", null]) assert.throws(() => assertChatReplyChannel({ conversation_type }), /Central de Reclamações/);
  for (const conversation_type of ["chat", "question", "post_sale"]) assert.doesNotThrow(() => assertChatReplyChannel({ conversation_type }));
  const source = readFileSync("lib/marketplace-conversations.ts", "utf8");
  const queued = source.slice(source.indexOf("export async function queueConversationReply"), source.indexOf("export async function executeConversationReply"));
  const execution = source.slice(source.indexOf("export async function executeConversationReply"), source.indexOf("export async function markConversationReplyError"));
  assert.ok(queued.indexOf("assertChatReplyChannel(conversation)") < queued.indexOf('.upsert('));
  assert.ok(execution.indexOf("assertChatReplyChannel(conversation)") < execution.indexOf("sendMercadoLivrePostSaleMessage"));
  assert.match(source, /if \(!current.data \|\| !isChatConversation\(current.data\)\) return/);
});
test("initial and incremental hydration use the same allowlist; event cursor includes excluded cases", () => {
  const page = readFileSync("app/chats-perguntas/page.tsx", "utf8");
  const delta = readFileSync("app/api/chats/changes/route.ts", "utf8");
  for (const source of [page, delta]) assert.match(source, /\.in\("conversation_type", CHAT_CONVERSATION_TYPES\)/);
  assert.match(delta, /changedConversationIds: changed.map/);
  assert.match(delta, /latestConversationCursor\(changed\)/);
  const sql = readFileSync("supabase/migrations/20261007233251_separate_chat_and_case_conversations.sql", "utf8");
  assert.match(sql, /conversation_type in \('question', 'chat', 'post_sale'\)/);
  assert.ok(sql.indexOf("conversation_type in") < sql.indexOf("), grouped as"));
  assert.doesNotMatch(sql.slice(sql.indexOf("with watermark"), sql.indexOf("), individual")), /conversation_type/);
});

test("case detail reads only official messages, without an automatic prior-history preview", async () => {
  const calls: Array<{ table: string; filters: any[] }> = [];
  const db: any = { from(table: string) {
    const call = { table, filters: [] as any[] }; calls.push(call);
    const q: any = {};
    for (const method of ["select", "eq", "in", "lt", "order", "limit", "range", "or", "maybeSingle", "is"]) q[method] = (...args: any[]) => { call.filters.push([method, ...args]); return q; };
    q.throwOnError = async () => {
      if (table === "marketplace_cases") return { data: { id: "case", marketplace: "mercado_livre", marketplace_account_id: "account", order_id: "order", case_type: "claim", external_case_id: "1", claim_created_at: "2026-10-07T00:00:00Z" } };
      if (table === "marketplace_conversations") return { data: call.filters.some(f => f[0] === "in") ? [normal()] : [claim()] };
      if (table === "marketplace_conversation_messages") return { data: call.filters.some(f => f[0] === "in") ? [normal().messages[0]] : claim().messages };
      return { data: [] };
    };
    return q;
  } };
  const detail = await loadCaseDetail("case", db);
  assert.equal(detail?.messageScope, "case");
  assert.deepEqual(detail?.messages.map(m => m.id), ["official"]);
  assert.equal("contextMessages" in detail!, false);
  assert.equal(calls.filter(c => c.table === "marketplace_conversation_messages").length, 1);
  for (const call of calls.filter(c => c.table === "marketplace_conversations")) {
    assert.ok(call.filters.some(f => f[0] === "eq" && f[1] === "marketplace_account_id" && f[2] === "account"));
  }
  assert.equal(calls.some(c => c.filters.some(f => f[0] === "lt" && f[1] === "sent_at")), false);
  assert.equal(calls.some(c => c.table === "marketplace_conversations" && c.filters.some(f => f[0] === "in")), false);
});
