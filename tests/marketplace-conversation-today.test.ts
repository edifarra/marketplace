import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { legacyConversationPagePlan, hydrateMarketplaceConversationPage, normalizeMarketplaceConversationPagePlan } from "../lib/marketplace-conversation-page";
import { mergeConversationDelta } from "../lib/marketplace-conversation-delta";
import { prepareConversationRows } from "../lib/marketplace-conversation-view";
import { shopeeConversationActivity } from "../lib/marketplace-special-messages";
const now = Date.parse("2026-10-04T20:00:00Z");
const view = { tab: "today" as const, marketplace: "", store: "", status: "", sla: "", search: "", from: "", to: "", unread: "" };
const old = "2026-10-03T16:46:58Z";
function row(id: string, pending: boolean, date = old) {
  return { id, marketplace: "shopee", conversation_type: "chat", buyer_name: "stephan_souza", requires_response: pending,
    status: pending ? "pending" : "answered", last_message_at: date, last_incoming_at: old, marketplace_conversation_messages: [] };
}
test("carregamento, páginas e polling mantêm pendências antigas e excluem respondidas antigas", () => {
  const source = Array.from({ length: 30 }, (_, i) => row(`pending-${i}`, true));
  source.push(row("answered-old", false), row("recent", false, "2026-10-04T19:00:00Z"));
  for (const page of [1, 2]) {
    const plan = legacyConversationPagePlan(source, view, page, 1, 6, now);
    const hydrated = hydrateMarketplaceConversationPage(source, normalizeMarketplaceConversationPagePlan(plan), 1, 6, now);
    assert.equal(plan.total, 31);
    assert.equal(hydrated.length, page === 1 ? 25 : 6);
    assert.ok(!hydrated.some(r => r.id === "answered-old"));
  }
  const rows = prepareConversationRows(source, 1, 6, now);
  const initial = legacyConversationPagePlan(source, view, 1, 1, 6, now).rows;
  assert.deepEqual(mergeConversationDelta([], rows, source.map(r => r.id), view, 25, now).map(r => r.id), initial.map(r => r.id));
  assert.deepEqual(mergeConversationDelta(initial, [], [], view, 25, now).map(r => r.id), initial.map(r => r.id));
});
test("resposta posterior encerra pendência; conversa recente fica, antiga respondida sai", () => {
  const customer = { message_type: "text", from_id: 1, content: { text: "Pergunta" } };
  const seller = { message_type: "text", from_id: 2, content: { text: "Resposta" } };
  const state = shopeeConversationActivity([customer, seller], m => m.from_id === 2);
  assert.equal(state.requiresResponse, false);
  const initial = prepareConversationRows([row("case", true)], 1, 6, now);
  const replied = prepareConversationRows([row("case", state.requiresResponse, "2026-10-04T19:59:00Z")], 1, 6, now);
  const merged = mergeConversationDelta(initial, replied, ["case"], view, 25, now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].requires_response, false);
  assert.equal(mergeConversationDelta(merged, [], [], view, 25, now + 25 * 3600000).length, 0);
});
test("migration altera somente janela da RPC e preserva paginação e permissões", () => {
  const original = readFileSync("supabase/migrations/20260929101919_optimize_initial_conversation_page.sql", "utf8");
  const migration = readFileSync("supabase/migrations/20261004201000_keep_pending_conversations_today.sql", "utf8");
  assert.equal(migration, original.replace("p_tab = 'all' or last_message_at >= p_now - interval '24 hours'", "p_tab = 'all' or requires_response or last_message_at >= p_now - interval '24 hours'"));
});
