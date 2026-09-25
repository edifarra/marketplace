import assert from "node:assert/strict";
import test from "node:test";
import {
  marketplaceMessageType,
  shopeeConversationActivity,
  shopeeMessageDirection,
  shopeeMessageImageUrl,
  shopeeMessageText,
  shopeeOutOfStockReminderContent
} from "../lib/marketplace-special-messages";

const buyerText = (text: string) => ({
  message_type: "text", source: "ios", from_id: 10, created_timestamp: 100,
  content: { text }
});
const sellerText = (text: string) => ({
  message_type: "text", source: "mini_webchat", from_id: 20, created_timestamp: 200,
  content: { text }
});
const reminder = {
  message_type: "out_of_stock_reminder_card", source: "server", from_id: 10, created_timestamp: 300,
  content: {
    seller_user_id: 20,
    product_info: { item_id: 58208834633, name: "Kit Cabo Flat", models: [{ model_stock: 6 }] }
  },
  source_content: {}
};
const isSeller = (message: Record<string, any>) => message.from_id === 20;

test("imagem Shopee com caption preserva imagem e texto do content.text", () => {
  const raw = {
    message_type: "image_with_text",
    content: { image_url: "https://example.invalid/image", text: "Ela vem junto?", caption: "" }
  };
  assert.equal(shopeeMessageImageUrl(raw), "https://example.invalid/image");
  assert.equal(shopeeMessageText(raw), "Ela vem junto?");
  assert.equal(marketplaceMessageType(raw), "image_with_text");
});

test("imagem Shopee sem caption continua normal", () => {
  const raw = { message_type: "image", content: { image_url: "https://example.invalid/image" } };
  assert.equal(shopeeMessageImageUrl(raw), "https://example.invalid/image");
  assert.equal(shopeeMessageText(raw), "");
});

test("out_of_stock_reminder_card confirmado pelo payload é evento de sistema", () => {
  assert.equal(shopeeMessageDirection(reminder, false), "system");
  assert.deepEqual(shopeeOutOfStockReminderContent(reminder), {
    title: "Lembrete da Shopee",
    description: "Seu produto pode estar sem estoque, por favor atualize o estoque caso necessário.",
    productName: "Kit Cabo Flat", itemId: "58208834633", stock: 6
  });
});

test("nome isolado do message_type não basta para classificar como sistema", () => {
  const unconfirmed = { ...reminder, source: "ios" };
  assert.equal(shopeeMessageDirection(unconfirmed, false), "incoming");
  assert.equal(shopeeOutOfStockReminderContent(unconfirmed), null);
});

test("reminder após resposta da loja mantém conversa respondida", () => {
  const state = shopeeConversationActivity([buyerText("Oi"), sellerText("Olá"), reminder], isSeller);
  assert.equal(state.direction, "outgoing");
  assert.equal(state.latest?.content.text, "Olá");
  assert.equal(state.requiresResponse, false);
  assert.equal(state.unread, false);
  assert.equal(state.latestIncoming?.content.text, "Oi");
  assert.equal(state.latestOutgoing?.content.text, "Olá");
});

test("reminder após cliente sem resposta mantém pendência na mensagem real", () => {
  const customer = buyerText("Ainda está disponível?");
  const state = shopeeConversationActivity([customer, reminder], isSeller);
  assert.equal(state.direction, "incoming");
  assert.equal(state.requiresResponse, true);
  assert.equal(state.unread, true);
  assert.equal(state.latest, customer);
  assert.equal(state.latestIncoming, customer);
  assert.equal(state.latestOutgoing, null);
});

test("reminder sozinho não cria incoming, unread ou requires_response", () => {
  const state = shopeeConversationActivity([reminder], isSeller);
  assert.equal(state.direction, null);
  assert.equal(state.requiresResponse, false);
  assert.equal(state.unread, false);
  assert.equal(state.latestIncoming, null);
  assert.equal(state.latestOutgoing, null);
});

test("texto comum do cliente continua funcionando", () => {
  const message = buyerText("Bom dia");
  assert.equal(shopeeMessageText(message), "Bom dia");
  assert.equal(shopeeMessageDirection(message, false), "incoming");
});

test("mensagens order e imagens corrigidas anteriormente continuam funcionando", () => {
  assert.equal(marketplaceMessageType({ message_type: "order", content: { order_sn: "260924SY5MUHJ8" } }), "order");
  assert.equal(shopeeMessageImageUrl({ message_type: "image", content: { image_url: "https://example.invalid/old" } }), "https://example.invalid/old");
});
