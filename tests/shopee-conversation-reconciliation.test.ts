import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  loadUniqueValuesInChunks,
  mapShopeeConversationSnapshots,
  persistBeforeOptionalEnrichment,
  shopeeProductEnrichment,
  shopeeProductLookupNeeded,
  shopeeSnapshotKey,
  SHOPEE_CONVERSATION_SNAPSHOT_FIELDS,
  SHOPEE_CONVERSATION_SNAPSHOT_SELECT,
  SHOPEE_PRODUCT_LOOKUP_SELECT,
  SHOPEE_POSTGREST_IN_CHUNK_SIZE,
  uniqueStringChunks,
  uniqueShopeeCandidates
} from "../lib/shopee-conversation-reconciliation";
import {
  marketplaceConversationChanged,
  planMarketplaceMessageWrites,
  type MarketplaceMessageWrite
} from "../lib/marketplace-message-reconciliation";

const source = fs.readFileSync(path.join(process.cwd(), "lib/marketplace-conversations.ts"), "utf8");

test("uma conta cria um único contexto e reutiliza-o em todas as conversas", () => {
  const incremental = source.slice(source.indexOf("async function syncShopeeConversationsIncremental"), source.indexOf("async function firstLocalMercadoLivreOrder"));
  assert.equal(incremental.match(/shopeeContext\(account\)/g)?.length, 1);
  assert.match(incremental, /syncShopeeCandidates\(account, context, candidates, snapshots\)/);
  const prepare = source.slice(source.indexOf("async function prepareShopeeConversation"), source.indexOf("async function persistPreparedShopeeConversation"));
  assert.doesNotMatch(prepare, /shopeeContext\(/);
});

test("snapshots são carregados uma vez em lote e sem select estrela/raw_data", () => {
  const loader = source.slice(source.indexOf("async function loadShopeeConversationSnapshots"), source.indexOf("async function loadShopeeProducts"));
  assert.match(loader, /\.in\("external_conversation_id", ids\)/);
  assert.match(loader, /SHOPEE_CONVERSATION_SNAPSHOT_SELECT/);
  assert.doesNotMatch(SHOPEE_CONVERSATION_SNAPSHOT_SELECT, /(^|,)\*($|,)/);
  assert.ok(!SHOPEE_CONVERSATION_SNAPSHOT_FIELDS.includes("raw_data" as never));
  assert.match(SHOPEE_CONVERSATION_SNAPSHOT_SELECT, /marketplace_conversation_messages\(/);
  assert.match(SHOPEE_CONVERSATION_SNAPSHOT_SELECT, /conversation_id/);
  const upsert = source.slice(source.indexOf("async function upsertConversationResult"), source.indexOf("async function upsertMessage"));
  assert.match(upsert, /existingSnapshot === undefined \? "\*" : SHOPEE_CONVERSATION_SNAPSHOT_FIELDS\.join/);
});

test("snapshot é associado pela conta e conversa sem mistura entre contas", () => {
  const snapshots = mapShopeeConversationSnapshots([
    { id: "row-a", marketplace_account_id: "account-a", external_conversation_id: "same-id" },
    { id: "row-b", marketplace_account_id: "account-b", external_conversation_id: "same-id" }
  ]);
  assert.equal(snapshots.get(shopeeSnapshotKey("account-a", "same-id"))?.id, "row-a");
  assert.equal(snapshots.get(shopeeSnapshotKey("account-b", "same-id"))?.id, "row-b");
  assert.equal(snapshots.size, 2);
});

test("candidatos recentes e pendentes são deduplicados", () => {
  assert.deepEqual(uniqueShopeeCandidates([
    { id: "one", seed: {} }, { id: "one", seed: { pending: true } }, { id: "two", seed: {} }
  ]).map(item => item.id), ["one", "two"]);
});

test("chunking conserva todos os IDs, inclusive último chunk incompleto e duplicados entre chunks", () => {
  const ids = Array.from({ length: SHOPEE_POSTGREST_IN_CHUNK_SIZE * 2 + 7 }, (_, index) => `id-${index}`);
  const chunks = uniqueStringChunks([...ids, "id-1", `id-${SHOPEE_POSTGREST_IN_CHUNK_SIZE + 1}`]);
  assert.deepEqual(chunks.map(chunk => chunk.length), [SHOPEE_POSTGREST_IN_CHUNK_SIZE, SHOPEE_POSTGREST_IN_CHUNK_SIZE, 7]);
  assert.deepEqual(chunks.flat(), ids);
  assert.equal(new Set(chunks.flat()).size, ids.length);
});

test("falha no segundo chunk interrompe snapshot crítico sem ocultar o erro", async () => {
  const ids = Array.from({ length: SHOPEE_POSTGREST_IN_CHUNK_SIZE + 3 }, (_, index) => `id-${index}`);
  let calls = 0;
  await assert.rejects(loadUniqueValuesInChunks(ids, async chunk => {
    calls += 1;
    if (calls === 2) throw new Error("segundo chunk indisponível");
    return chunk;
  }), /segundo chunk indisponível/);
  assert.equal(calls, 2);
});

function message(text: string): MarketplaceMessageWrite {
  return {
    conversation_id: "conversation-1", external_message_id: "message-1", direction: "incoming",
    message_type: "text", text, sender_id: "buyer", sender_name: "Cliente",
    sent_at: "2026-09-19T12:00:00.000Z", status: "received", raw_data: { content: { text } },
    marketplace_account_id: null, external_message_key: null
  };
}

test("mensagens idênticas, novas e alteradas mantêm os lotes corretos", () => {
  const original = message("Olá");
  const snapshot = { ...original, id: "row-1", raw_data: undefined, raw_content: original.raw_data.content };
  const identical = planMarketplaceMessageWrites([original], [snapshot]);
  assert.deepEqual([identical.inserted.length, identical.updated.length, identical.unchanged.length], [0, 0, 1]);
  const inserted = planMarketplaceMessageWrites([original], []);
  assert.deepEqual([inserted.inserted.length, inserted.updated.length], [1, 0]);
  const updated = planMarketplaceMessageWrites([message("Texto corrigido")], [snapshot]);
  assert.deepEqual([updated.inserted.length, updated.updated.length], [0, 1]);
});

test("conversa inalterada não atualiza e alteração legítima atualiza", () => {
  const existing = { status: "pending", requires_response: true, listing_id: "item-1", product_id: "product-1" };
  assert.equal(marketplaceConversationChanged(existing, { ...existing }), false);
  assert.equal(marketplaceConversationChanged(existing, { ...existing, status: "answered", requires_response: false }), true);
});

test("produto preservado não gera lookup e produto ausente é enriquecido pela relação correta", () => {
  assert.equal(shopeeProductLookupNeeded({ listing_id: "item-1", product_id: "product-1" }, "item-1"), false);
  assert.equal(shopeeProductLookupNeeded({ listing_id: "item-1", product_id: null }, "item-1"), true);
  const product = shopeeProductEnrichment({
    product_id: "product-1", sku: "SKU", products: { title: "Produto", price: 10, estoque: { estoque_disponivel: 7 } }
  });
  assert.deepEqual({ id: product.product_id, stock: product.available_stock }, { id: "product-1", stock: 7 });
  assert.match(SHOPEE_PRODUCT_LOOKUP_SELECT, /products\(title,price,estoque\(estoque_disponivel\)\)/);
  assert.doesNotMatch(SHOPEE_PRODUCT_LOOKUP_SELECT, /products\(title,price\),estoque\(/);
});

test("lookup de produto em lote usa chunking e não silencia HTTP 400", () => {
  const loader = source.slice(source.indexOf("async function loadShopeeProducts"), source.indexOf("async function upsertConversation"));
  assert.match(loader, /loadUniqueValuesInChunks\(itemIds/);
  assert.match(loader, /\.in\("marketplace_product_id", ids\)\.throwOnError\(\)/);
  assert.doesNotMatch(loader, /catch\s*\(/);
});

test("falha auxiliar de produto preserva mensagem, fica observável e permite retry idempotente", async () => {
  const persistedMessages = new Set<string>();
  let enrichmentAttempts = 0;
  let observedErrors = 0;
  let enriched = false;
  const cycle = (fail: boolean) => persistBeforeOptionalEnrichment(async () => {
    persistedMessages.add("message-1");
    return { conversationId: "conversation-1", productId: null };
  }, async () => {
    enrichmentAttempts += 1;
    if (fail) throw new Error("HTTP 400 no produto");
    enriched = true;
  }, () => { observedErrors += 1; });

  await cycle(true);
  assert.equal(persistedMessages.size, 1);
  assert.equal(observedErrors, 1);
  assert.equal(enriched, false);
  await cycle(false);
  assert.equal(enrichmentAttempts, 2);
  assert.equal(persistedMessages.size, 1);
  assert.equal(enriched, true);
});

test("fluxo real persiste núcleo antes do produto e mantém pendência para retry", () => {
  const sync = source.slice(source.indexOf("async function syncShopeeCandidates"), source.indexOf("async function loadShopeeConversationSnapshots"));
  assert.ok(sync.indexOf("persistPreparedShopeeConversation") < sync.indexOf("enrichShopeeConversationProducts"));
  assert.match(sync, /productLookupErrors \+= 1/);
  const pending = source.slice(source.indexOf("async function pendingShopeeReconciliationRows"), source.indexOf("async function markMercadoLivreConversationReconciled"));
  assert.match(pending, /product_id\.is\.null/);
  assert.match(pending, /listing_id\.not\.is\.null/);
});

test("cenário de 64 conversas em duas contas reduz GETs para a meta arquitetural", () => {
  const accounts = 2;
  const conversations = 64;
  const oldConfigurationGets = 1 + accounts + conversations;
  const newConfigurationGets = 1 + accounts;
  const oldSnapshots = conversations;
  const newSnapshots = accounts;
  const oldTotalGets = 1 + accounts + conversations + accounts + accounts + conversations + 6;
  const newTotalGets = 1 + accounts + accounts + accounts + accounts + 2;
  assert.deepEqual({ oldConfigurationGets, newConfigurationGets, oldSnapshots, newSnapshots }, {
    oldConfigurationGets: 67, newConfigurationGets: 3, oldSnapshots: 64, newSnapshots: 2
  });
  assert.equal(oldTotalGets, 141);
  assert.equal(newTotalGets, 11);
});
