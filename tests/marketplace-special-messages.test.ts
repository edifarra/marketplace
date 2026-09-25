import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { conversationTimelineSections } from "../lib/marketplace-conversation-view";
import { serveMercadoLivreAttachment } from "../lib/marketplace-attachment-proxy";
import {
  mapLocalOrderProducts,
  marketplaceMessageType,
  mercadoLivreAttachments,
  resolveMercadoLivrePackOrder,
  shopeeConversationReferences
} from "../lib/marketplace-special-messages";

const historicalAttachment = {
  message_attachments: [{
    tag: "post_sale", size: 473003, type: "image/jpeg",
    filename: "130624582_3c8d3663-f629-48a6-b94f-dc130818e87f.jpeg",
    original_filename: "94beccd1-cbad-45ad-a7bf-0b4ff3d3ba9c.jpeg"
  }]
};

test("B1: pack ML sem order remoto usa a venda local existente", async () => {
  let observed = false;
  const orderId = await resolveMercadoLivrePackOrder("2000018538592826",
    async () => { throw new Error("pack unavailable"); },
    async candidates => candidates.includes("2000018538592826") ? "2000018538592826" : null,
    () => { observed = true; });
  assert.equal(orderId, "2000018538592826");
  assert.equal(observed, true);
  const product = mapLocalOrderProducts([{ order_id: orderId, data_venda: "2026-09-19T12:51:08Z", venda_item: [{
    sku: "1132AU", valor_unitario: 39, raw_data: { item: { id: "MLB7479600826" } }
  }] }], [{ id: "477cc050-b4ac-4fd2-a11e-89f31ccba894", sku: "1132AU", title: "Par de Alto Falantes TV Lc5551fda", estoque: [{ estoque_disponivel: 1 }] }]).get(String(orderId));
  assert.equal(product?.product_id, "477cc050-b4ac-4fd2-a11e-89f31ccba894");
  assert.equal(product?.sku, "1132AU");
});

test("B1: conversa post_sale fica integralmente na timeline pós-venda sem purchased_at", () => {
  const message = { id: "message", sent_at: "2026-09-19T12:00:00Z" };
  assert.deepEqual(conversationTimelineSections({ conversation_type: "post_sale", purchased_at: null, messages: [message] }), {
    before: [], after: [message], purchase: null, postSaleOnly: true
  });
});

test("B2: attachment histórico ML é reconhecido como imagem e preserva o identificador", () => {
  assert.equal(marketplaceMessageType(historicalAttachment), "image");
  assert.deepEqual(mercadoLivreAttachments(historicalAttachment)[0], {
    id: "130624582_3c8d3663-f629-48a6-b94f-dc130818e87f.jpeg",
    name: "94beccd1-cbad-45ad-a7bf-0b4ff3d3ba9c.jpeg",
    mimeType: "image/jpeg", size: 473003, tag: "post_sale", isImage: true
  });
});

test("B2: os três IDs históricos continuam renderizáveis diretamente do raw_data", () => {
  const cases = [
    ["01a0cf70e11372c1bfb27307c8e26709", "130624582_3c8d3663-f629-48a6-b94f-dc130818e87f.jpeg"],
    ["01a0cf7171077702ae1b269bba9fb91d", "130624582_07d04c81-d05d-4ad5-8cb5-aaa3faa686e1.jpeg"],
    ["01a0cf735be870a4b370204afdc2f030", "130624582_c03bf53e-f4d6-4578-9e57-fdbe7fda3ee8.jpeg"]
  ];
  for (const [messageId, filename] of cases) {
    const attachments = mercadoLivreAttachments({ message_id: messageId, message_attachments: [{ filename, type: "image/jpeg", tag: "post_sale" }] });
    assert.equal(attachments[0]?.id, filename);
    assert.equal(attachments[0]?.isImage, true);
  }
});

test("B2: proxy deriva conta da conversa, não expõe token e transmite o attachment", async () => {
  const token = "never-expose-this-token";
  const response = await serveMercadoLivreAttachment("message", 0, {
    authenticated: async () => true,
    loadMessage: async () => ({ conversation_id: "conversation", raw_data: historicalAttachment }),
    loadConversation: async () => ({ id: "conversation", marketplace: "mercado_livre", marketplace_account_id: "account" }),
    loadAccount: async () => ({ id: "account", marketplace: "mercado_livre", access_token: token }),
    fetchAttachment: async (id, tag, account) => {
      assert.equal(id, mercadoLivreAttachments(historicalAttachment)[0].id);
      assert.equal(tag, "post_sale");
      assert.equal(account.access_token, token);
      return new Response("image-bytes", { headers: { "content-type": "image/jpeg" } });
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.doesNotMatch(`${[...response.headers]} ${await response.text()}`, new RegExp(token));
});

test("B2: conversa/conta incompatível é negada antes de chamar o marketplace", async () => {
  let fetched = false;
  const response = await serveMercadoLivreAttachment("message", 0, {
    authenticated: async () => true,
    loadMessage: async () => ({ conversation_id: "conversation", raw_data: historicalAttachment }),
    loadConversation: async () => ({ marketplace: "shopee", marketplace_account_id: "account" }),
    loadAccount: async () => ({ id: "account", marketplace: "mercado_livre" }),
    fetchAttachment: async () => { fetched = true; return new Response(); }
  });
  assert.equal(response.status, 403);
  assert.equal(fetched, false);
});

test("B2: conta diferente da conta persistida na conversa é negada", async () => {
  const response = await serveMercadoLivreAttachment("message", 0, {
    authenticated: async () => true,
    loadMessage: async () => ({ conversation_id: "conversation", raw_data: historicalAttachment }),
    loadConversation: async () => ({ marketplace: "mercado_livre", marketplace_account_id: "account-a" }),
    loadAccount: async () => ({ id: "account-b", marketplace: "mercado_livre" }),
    fetchAttachment: async () => new Response("should-not-run")
  });
  assert.equal(response.status, 403);
});

test("B2: attachment remoto 404 retorna indisponível sem lançar exceção", async () => {
  const response = await serveMercadoLivreAttachment("message", 0, {
    authenticated: async () => true,
    loadMessage: async () => ({ conversation_id: "conversation", raw_data: historicalAttachment }),
    loadConversation: async () => ({ marketplace: "mercado_livre", marketplace_account_id: "account" }),
    loadAccount: async () => ({ id: "account", marketplace: "mercado_livre" }),
    fetchAttachment: async () => new Response(null, { status: 404 })
  });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /indisponível/);
});

test("B3: source_content.order_sn antigo permanece após mensagens textuais", () => {
  const references = shopeeConversationReferences([
    { message_type: "order", content: { order_sn: "260924SY5MUHJ8" } },
    { message_type: "text", content: { text: "Boa tarde" }, source_content: { order_sn: "260924SY5MUHJ8" } },
    { message_type: "text", content: { text: "Disponha" } }
  ]);
  assert.equal(references.orderSn, "260924SY5MUHJ8");
});

test("B3: pedido local em lote resolve SKU, produto e item Shopee", () => {
  const mapped = mapLocalOrderProducts([{ order_id: "260924SY5MUHJ8", data_venda: "2026-09-23T19:55:03Z", venda_item: [{
    sku: "1017PP", valor_unitario: 239, raw_data: { order: { item_list: [{ item_id: 22794753242 }] } }
  }] }], [{ id: "product", sku: "1017PP", title: "Placa Principal Tv Semp Tcl 50p635 / Id:794 V2", price: 239, estoque: [{ estoque_disponivel: 1 }] }]);
  assert.deepEqual(mapped.get("260924SY5MUHJ8"), {
    order_id: "260924SY5MUHJ8", listing_id: "22794753242", purchased_at: "2026-09-23T19:55:03Z",
    product_id: "product", sku: "1017PP", product_title: "Placa Principal Tv Semp Tcl 50p635 / Id:794 V2",
    product_price: 239, available_stock: 1
  });
});

test("B3: ausência de referências usa fallback seguro e texto comum não muda", () => {
  assert.deepEqual(shopeeConversationReferences([{ message_type: "text", content: { text: "Olá" } }]), { itemId: "", orderSn: "" });
  assert.equal(marketplaceMessageType({ message_type: "text", content: { text: "Olá" } }), "text");
});

test("performance: fallback de pack é por conversa e pedidos Shopee são consultados em lote", () => {
  const source = fs.readFileSync(new URL("../lib/marketplace-conversations.ts", import.meta.url), "utf8");
  const packFallback = source.slice(source.indexOf("async function firstLocalMercadoLivreOrderForPack"), source.indexOf("function resolveReplyRecipient"));
  assert.match(packFallback, /select\("order_id,pack_id"\)/);
  assert.equal(packFallback.match(/supabaseAdmin\(\)/g)?.length, 1);
  const orderLoader = source.slice(source.indexOf("async function loadOrderProducts"), source.indexOf("async function findMercadoLivreAccount"));
  assert.match(orderLoader, /\.in\("order_id", uniqueOrderIds\)/);
  assert.match(orderLoader, /\.in\("sku", skus\)/);
  assert.doesNotMatch(orderLoader, /for\s*\([^)]*order/);
});
