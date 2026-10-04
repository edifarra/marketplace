import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MARKETPLACE_CONVERSATION_PAGE_SELECT,
  hydrateMarketplaceConversationPage,
  legacyConversationPagePlan,
  normalizeMarketplaceConversationPagePlan
} from "../lib/marketplace-conversation-page";
import { ConversationView } from "../lib/marketplace-conversation-view";
import { attachShopeeMessageProductCards } from "../lib/shopee-message-product-cards";

const NOW = new Date("2026-09-29T12:00:00.000Z").getTime();
const allView: ConversationView = { tab: "all", marketplace: "", store: "", status: "", sla: "", search: "", from: "", to: "", unread: "" };
const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const message = (id: number, sentAt: string, text = `Mensagem ${id}`) => ({
  id: uuid(10_000 + id), external_message_id: String(id), direction: "incoming", message_type: "text",
  text, sender_name: "Cliente", sent_at: sentAt, status: "received", raw_data: {}
});
const conversation = (number: number, overrides: Record<string, any> = {}) => ({
  id: uuid(number), marketplace: "shopee", marketplace_account_id: uuid(9_001), conversation_type: "chat",
  external_conversation_id: `external-${number}`, external_status: "normal", status: "answered",
  requires_response: false, unread: false, buyer_id: `buyer-${number}`, buyer_name: `Comprador ${number}`,
  product_id: uuid(20_000 + number), listing_id: `listing-${number}`, order_id: `order-${number}`,
  sku: `SKU-${number}`, product_title: `Produto ${number}`, product_price: number, available_stock: 5,
  last_incoming_at: new Date(NOW - number * 60_000).toISOString(),
  last_message_at: new Date(NOW - number * 60_000).toISOString(), updated_at: new Date(NOW).toISOString(),
  raw_data: {}, marketplace_conversation_messages: [message(number, new Date(NOW - number * 60_000).toISOString())],
  ...overrides
});

function compareOldAndHydrated(rows: Array<Record<string, any>>, view = allView, page = 1) {
  const before = legacyConversationPagePlan(rows, view, page, 1, 6, NOW);
  const rpcContract = normalizeMarketplaceConversationPagePlan(before);
  const after = hydrateMarketplaceConversationPage(rows, rpcContract, 1, 6, NOW);
  assert.deepEqual(after.map(row => row.groupKey), before.rows.map(row => row.groupKey));
  return { before, after };
}

test("primeira página e página seguinte preservam 25 grupos e ordenação", () => {
  const rows = Array.from({ length: 40 }, (_, index) => conversation(index + 1));
  const first = compareOldAndHydrated(rows, allView, 1);
  const second = compareOldAndHydrated(rows, allView, 2);
  assert.equal(first.after.length, 25);
  assert.equal(second.after.length, 15);
  assert.equal(first.before.total, 40);
  assert.equal(first.before.rows[0].id, uuid(1));
  assert.equal(second.before.rows[0].id, uuid(26));
});

test("exatamente 25 registros produzem uma página e contagem exata", () => {
  const result = compareOldAndHydrated(Array.from({ length: 25 }, (_, index) => conversation(index + 1)));
  assert.equal(result.before.total, 25);
  assert.equal(result.before.page, 1);
  assert.equal(result.after.length, 25);
});

test("aba hoje mantém conversas recentes e pendências antigas", () => {
  const rows = [
    conversation(1, { last_message_at: new Date(NOW - 23 * 3600_000).toISOString() }),
    conversation(2, { last_message_at: new Date(NOW - 25 * 3600_000).toISOString() }),
    conversation(3, { requires_response: true, status: "pending", last_message_at: new Date(NOW - 48 * 3600_000).toISOString() })
  ];
  const result = compareOldAndHydrated(rows, { ...allView, tab: "today" });
  assert.deepEqual(result.after.map(row => row.id), [uuid(1), uuid(3)]);
});

test("status, marketplace e conta preservam a seleção anterior", () => {
  const account = uuid(9_002);
  const rows = [
    conversation(1, { status: "pending", requires_response: true, marketplace: "mercado_livre", marketplace_account_id: account }),
    conversation(2, { status: "answered", marketplace: "mercado_livre", marketplace_account_id: account }),
    conversation(3, { status: "pending", requires_response: true, marketplace: "shopee", marketplace_account_id: account })
  ];
  const result = compareOldAndHydrated(rows, { ...allView, status: "pending", marketplace: "mercado_livre", store: account });
  assert.deepEqual(result.after.map(row => row.id), [uuid(1)]);
});

test("busca textual mantém SKU, anúncio, comprador, pedido e título", () => {
  const row = conversation(1, { sku: "CAM-42", listing_id: "MLB123", buyer_name: "Maria Silva", buyer_id: "buyer-special", order_id: "ORDER-77", product_title: "Camiseta Azul" });
  for (const search of ["cam-42", "mlb123", "maria", "buyer-special", "order-77", "camiseta"]) {
    const result = compareOldAndHydrated([row, conversation(2)], { ...allView, search });
    assert.deepEqual(result.after.map(item => item.id), [uuid(1)], search);
  }
});

test("perguntas relacionadas continuam sendo uma unidade com toda a timeline", () => {
  const common = { marketplace: "mercado_livre", conversation_type: "question", marketplace_account_id: uuid(9_003), buyer_id: "buyer", sku: "SKU-GROUP" };
  const rows = [
    conversation(1, { ...common, requires_response: false, status: "answered", last_message_at: "2026-09-29T10:00:00.000Z", marketplace_conversation_messages: [message(1, "2026-09-29T10:00:00.000Z")] }),
    conversation(2, { ...common, requires_response: true, unread: true, status: "pending", last_message_at: "2026-09-29T11:00:00.000Z", marketplace_conversation_messages: [message(2, "2026-09-29T11:00:00.000Z")] })
  ];
  const result = compareOldAndHydrated(rows, { ...allView, status: "pending" });
  assert.equal(result.before.total, 1);
  assert.equal(result.after[0].question_count, 2);
  assert.deepEqual(result.after[0].messages.map(item => item.external_message_id), ["1", "2"]);
});

test("perguntas, pós-venda e chat Shopee preservam seus tipos", () => {
  const rows = [
    conversation(1, { marketplace: "mercado_livre", conversation_type: "question" }),
    conversation(2, { marketplace: "mercado_livre", conversation_type: "post_sale" }),
    conversation(3, { marketplace: "shopee", conversation_type: "chat" })
  ];
  const result = compareOldAndHydrated(rows);
  assert.deepEqual(new Set(result.after.map(row => row.conversation_type)), new Set(["question", "post_sale", "chat"]));
});

test("SLA dentro e fora mantém produto, pendência e horário de referência", () => {
  const rows = [
    conversation(1, { requires_response: true, status: "pending", last_incoming_at: new Date(NOW - 2 * 3600_000).toISOString() }),
    conversation(2, { requires_response: true, status: "pending", last_incoming_at: new Date(NOW - 30 * 60_000).toISOString() }),
    conversation(3, { requires_response: false, product_id: null, listing_id: null, last_incoming_at: new Date(NOW - 10 * 3600_000).toISOString() })
  ];
  assert.deepEqual(compareOldAndHydrated(rows, { ...allView, sla: "outside" }).after.map(row => row.id), [uuid(1)]);
  assert.deepEqual(compareOldAndHydrated(rows, { ...allView, sla: "inside" }).after.map(row => row.id), [uuid(2)]);
});

test("conversa com muitas mensagens carrega todo o histórico somente quando pertence à página", () => {
  const many = Array.from({ length: 300 }, (_, index) => message(index + 1, new Date(NOW - (300 - index) * 1000).toISOString()));
  const rows = [conversation(1, { marketplace_conversation_messages: many }), conversation(2, { marketplace_conversation_messages: [] })];
  const result = compareOldAndHydrated(rows);
  assert.equal(result.after.find(row => row.id === uuid(1))?.messages.length, 300);
  assert.equal(result.after.find(row => row.id === uuid(2))?.messages.length, 0);
});

test("enriquecimento Shopee continua limitado às mensagens da página", () => {
  const row = conversation(1, { marketplace_conversation_messages: [message(1, "2026-09-29T11:00:00.000Z", "Produto") ] });
  row.marketplace_conversation_messages[0].raw_data = { message_type: "item", content: { item_id: "item-1" } };
  const products = new Map([[`${row.marketplace_account_id}:item-1`, {
    marketplace_product_id: "item-1", product_id: uuid(30_001), sku: "SKU-CARD", titulo_marketplace: "Produto do card",
    valor_marketplace: 99, estoque_marketplace: 3, status_anuncio: "NORMAL", raw_data: { thumbnail: "https://example.test/image.jpg" }
  }]]);
  const enriched = attachShopeeMessageProductCards([row], products);
  const result = compareOldAndHydrated(enriched);
  assert.equal(result.after[0].messages[0].shopee_item_card.sku, "SKU-CARD");
});

test("filtros de data e não lidas preservam contagem e página", () => {
  const rows = [
    conversation(1, { unread: true, last_message_at: "2026-09-28T12:00:00.000Z" }),
    conversation(2, { unread: true, last_message_at: "2026-09-27T12:00:00.000Z" }),
    conversation(3, { unread: false, last_message_at: "2026-09-28T13:00:00.000Z" })
  ];
  const result = compareOldAndHydrated(rows, { ...allView, from: "2026-09-28", to: "2026-09-28", unread: "1" });
  assert.equal(result.before.total, 1);
  assert.deepEqual(result.after.map(row => row.id), [uuid(1)]);
});

test("seleção explícita conserva raw_data necessário e evita colunas operacionais", () => {
  assert.match(MARKETPLACE_CONVERSATION_PAGE_SELECT, /raw_data/);
  assert.match(MARKETPLACE_CONVERSATION_PAGE_SELECT, /marketplace_conversation_messages\(id,/);
  assert.doesNotMatch(MARKETPLACE_CONVERSATION_PAGE_SELECT, /\*/);
  assert.doesNotMatch(MARKETPLACE_CONVERSATION_PAGE_SELECT, /last_reconciled_at/);
});

test("migration pagina grupos antes de expandir IDs e restringe a RPC ao service role", () => {
  const sql = readFileSync("supabase/migrations/20260929101919_optimize_initial_conversation_page.sql", "utf8");
  assert.match(sql, /group by group_key/i);
  assert.match(sql, /with watermark as[\s\S]*order by updated_at desc, id desc/i);
  assert.match(sql, /limit \(select page_size from requested\)/i);
  assert.match(sql, /unnest\(conversation_ids\)/i);
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /security definer/i);
});
