import assert from "node:assert/strict";
import test from "node:test";
import { conversationProductLinks } from "../app/chats-perguntas/product-links";
import { attachShopeeMessageProductCards } from "../lib/shopee-message-product-cards";
import { prepareConversationRows } from "../lib/marketplace-conversation-view";

test("Shopee usa o último card do histórico e o catálogo da conta do chat", () => {
  const row = {
    id: "974656379479497586", marketplace: "shopee", marketplace_account_id: "store-a",
    config_marketplace_accounts: { shop_id: "123" }, product_id: "stale", listing_id: "stale",
    raw_data: { product_url: "https://wrong-store.invalid" },
    messages: [
      { direction: "incoming", sent_at: "2026-10-07T12:00:00Z", raw_data: { item_id: "last" } },
      { direction: "incoming", sent_at: "2026-10-07T11:00:00Z", raw_data: { item_id: "first" } },
      { direction: "outgoing", sent_at: "2026-10-07T13:00:00Z", raw_data: { item_id: "first" } }
    ]
  };
  const catalog = new Map([
    ["store-a:first", { product_id: "older-product", sku: "OLDER" }],
    ["store-a:last", { product_id: "correct-product", sku: "819TC.271125" }],
    ["store-b:last", { product_id: "wrong-product", sku: "WRONG" }]
  ]);
  const [prepared] = prepareConversationRows(attachShopeeMessageProductCards([row], catalog), 24, 24);
  assert.equal(prepared.messages[1].shopee_item_card.sku, "819TC.271125");
  assert.deepEqual(conversationProductLinks(prepared), {
    productId: "correct-product", listingUrl: "https://shopee.com.br/product/123/last"
  });
  assert.equal(prepared.product_id, "stale");
  assert.deepEqual(conversationProductLinks({ ...prepared, config_marketplace_accounts: { shop_id: "456" } }), {
    productId: "correct-product", listingUrl: "https://shopee.com.br/product/456/last"
  });
});

test("Shopee sem card não reutiliza links antigos; item desconhecido não inventa produto ou loja", () => {
  const [row] = prepareConversationRows([{ id: "chat", marketplace: "shopee", product_id: "stale", messages: [] }], 24, 24);
  assert.deepEqual(conversationProductLinks(row), { productId: null, listingUrl: null });
  const unknown = { ...row, messages: [{ direction: "incoming", shopee_item_card: { item_id: "unknown", found: false } }] };
  assert.deepEqual(conversationProductLinks(unknown), { productId: null, listingUrl: null });
  assert.deepEqual(conversationProductLinks({ ...unknown, config_marketplace_accounts: { shop_id: "123" } }), {
    productId: null, listingUrl: "https://shopee.com.br/product/123/unknown"
  });
});

test("Mercado Livre mantém produto da conversa, permalink e fallback atuais", () => {
  const [row] = prepareConversationRows([{ id: "ml", marketplace: "mercado_livre", product_id: "ml-product", listing_id: "MLB123", messages: [] }], 24, 24);
  assert.deepEqual(conversationProductLinks(row), { productId: "ml-product", listingUrl: "https://produto.mercadolivre.com.br/MLB-123-_JM" });
  for (const field of ["item_permalink", "permalink", "product_url"]) {
    assert.deepEqual(conversationProductLinks({ ...row, raw_data: { [field]: "https://listing.invalid" } }), {
      productId: "ml-product", listingUrl: "https://listing.invalid"
    });
  }
});
