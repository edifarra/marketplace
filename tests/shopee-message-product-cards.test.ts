import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  attachShopeeMessageProductCards,
  explicitShopeeMessageItemId,
  messagesWithVisibleShopeeProductCards
} from "../lib/shopee-message-product-cards";

const accountId = "account-shopee";
const originalConversation = {
  id: "conversation",
  marketplace: "shopee",
  marketplace_account_id: accountId,
  product_id: "main-product",
  listing_id: "main-listing",
  sku: "MAIN-SKU",
  product_title: "Produto principal",
  marketplace_conversation_messages: [
    { id: "text-item", text: "E esse?", raw_data: { message_type: "text", source_content: { item_id: 58218919949 } } },
    { id: "item", raw_data: { message_type: "item", content: { item_id: 22794753242 } } },
    { id: "plain", text: "Tem estoque?", raw_data: { message_type: "text", content: { text: "Tem estoque?" } } }
  ]
};

const products = new Map([[`${accountId}:58218919949`, {
  marketplace_product_id: "58218919949",
  product_id: "referenced-product",
  sku: "REF-SKU",
  titulo_marketplace: "Anúncio citado",
  valor_marketplace: 129.9,
  status_anuncio: "NORMAL",
  raw_data: { image: { image_url_list: ["https://example.invalid/item.jpg"] } },
  products: { title: "Produto local", price: 120, estoque: [{ estoque_disponivel: 3 }] }
}]]);

test("mensagem de texto extrai source_content.item_id explícito", () => {
  assert.equal(explicitShopeeMessageItemId(originalConversation.marketplace_conversation_messages[0].raw_data), "58218919949");
});

test("mensagem do tipo item extrai content.item_id explícito", () => {
  assert.equal(explicitShopeeMessageItemId(originalConversation.marketplace_conversation_messages[1].raw_data), "22794753242");
  assert.equal(explicitShopeeMessageItemId({ message_type: "text", content: { item_id: 999 } }), "");
});

test("duas mensagens recebem cards independentes sem alterar produto principal da conversa", () => {
  const [result] = attachShopeeMessageProductCards([originalConversation], products);
  const [first, second, third] = result.marketplace_conversation_messages;
  assert.deepEqual(first.shopee_item_card, {
    item_id: "58218919949", found: true, product_id: "referenced-product", sku: "REF-SKU",
    title: "Anúncio citado", price: 129.9, stock: 3, status: "NORMAL",
    image_url: "https://example.invalid/item.jpg", permalink: null
  });
  assert.deepEqual(second.shopee_item_card, { item_id: "22794753242", found: false });
  assert.equal(third.shopee_item_card, undefined);
  assert.equal(result.product_id, "main-product");
  assert.equal(result.listing_id, "main-listing");
  assert.equal(result.sku, "MAIN-SKU");
  assert.equal(result.product_title, "Produto principal");
  assert.equal((originalConversation.marketplace_conversation_messages[0] as Record<string, any>).shopee_item_card, undefined);
});

test("item_id não localizado preserva a referência mínima sem inventar produto", () => {
  const [result] = attachShopeeMessageProductCards([originalConversation], new Map());
  assert.deepEqual(result.marketplace_conversation_messages[0].shopee_item_card, { item_id: "58218919949", found: false });
  assert.equal(result.product_id, originalConversation.product_id);
  assert.equal(result.listing_id, originalConversation.listing_id);
});

test("cards visíveis seguem apenas as trocas de item explícitas das mensagens incoming", () => {
  const incoming = (id: string, itemId?: string) => ({
    id,
    direction: "incoming",
    ...(itemId ? { shopee_item_card: { item_id: itemId, found: true } } : {})
  });
  const messages = [
    incoming("a", "X"),
    incoming("b", "X"),
    { id: "seller", direction: "outgoing", shopee_item_card: { item_id: "Y", found: true } },
    incoming("c", "X"),
    incoming("d", "Y"),
    incoming("e", "Y"),
    incoming("no-item"),
    incoming("f", "Y"),
    incoming("g", "X")
  ];

  const visible = messagesWithVisibleShopeeProductCards(messages);
  assert.deepEqual(messages.filter(message => visible.has(message)).map(message => message.id), ["a", "d", "g"]);
});

test("UI usa exclusivamente o card transitório da mensagem e não o cabeçalho para anúncio citado", () => {
  const source = fs.readFileSync(new URL("../app/chats-perguntas/conversation-grid.tsx", import.meta.url), "utf8");
  const messageRenderer = source.slice(source.indexOf("function Message("), source.indexOf("function relativeTime("));
  assert.match(messageRenderer, /message\.shopee_item_card/);
  assert.match(messageRenderer, /O cliente está perguntando sobre este anúncio\/produto/);
  assert.match(messageRenderer, /message-item-card[\s\S]*\{bubble\}/);
  assert.match(messageRenderer, /if \(!showItemCard \|\| !itemCard\) return bubble/);
  assert.doesNotMatch(messageRenderer, /isItem/);
});

test("reconciliação não usa item_id da mensagem para trocar listing_id da conversa", () => {
  const source = fs.readFileSync(new URL("../lib/marketplace-conversations.ts", import.meta.url), "utf8");
  const preparation = source.slice(source.indexOf("async function prepareShopeeConversation"), source.indexOf("async function persistPreparedShopeeConversation"));
  assert.match(preparation, /const itemId = String\(detail\.item_id \|\| seed\.item_id \|\| ""\)/);
  assert.match(preparation, /listing_id: itemId \|\| existing\?\.listing_id \|\| null/);
  assert.doesNotMatch(preparation, /const \{ itemId, orderSn \} = shopeeConversationReferences/);
});
