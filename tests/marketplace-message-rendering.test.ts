import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../scripts/register-server-only.cjs";
import { Message } from "../app/chats-perguntas/conversation-grid";

// tsx runs the repository's preserved JSX outside Next's JSX transform.
Object.assign(globalThis, { React });
const orderSn = "261002GM4JC86B";
const text = "Chegou hoje e percebi que comprei o modelo da teve errado, era 50 e não 55";
const row: any = { marketplace: "shopee", order_id: orderSn, product_title: "Cabo Flat Lvds + Modulo Wi-fi + Botão Philips 55pug7406/78", messages: [] };
function render(type: string, content: Record<string, any>, direction = "incoming", marketplace = "shopee") {
  return renderToStaticMarkup(React.createElement(Message, {
    row: { ...row, marketplace }, showItemCard: false,
    message: { id: "2439066547202146673", message_type: type, text: content.text || "", direction,
      sender_name: "stephan_souza", sent_at: "2026-10-03T16:46:58Z",
      raw_data: { message_type: type, content, source_content: { order_sn: orderSn } } }
  }));
}
test("stephan_souza: texto com referência de pedido permanece visível", () => {
  const html = render("text", { text });
  assert.ok(html.includes(text));
  assert.ok(!html.includes('class="chat-product-card"'));
});
test("resposta da loja e texto Mercado Livre preservam texto com order_sn", () => {
  for (const marketplace of ["shopee", "mercado_livre"]) {
    assert.ok(render("text", { text: "Olá boa tarde" }, "outgoing", marketplace).includes("Olá boa tarde"));
  }
});
test("tipo order explícito continua exibindo cartão", () => {
  const html = render("order", { order_sn: orderSn });
  assert.ok(html.includes('class="chat-product-card"'));
  assert.ok(html.includes(orderSn));
  assert.ok(html.includes(row.product_title));
});
test("imagem com referência a pedido conserva imagem e legenda", () => {
  for (const type of ["image", "image_with_text"]) {
    const html = render(type, { image_url: "https://example.test/image.jpg", text: "Veja esta peça" });
    assert.ok(html.includes('class="chat-attachment"'));
    assert.ok(html.includes("Veja esta peça"));
    assert.ok(!html.includes('class="chat-product-card"'));
  }
});
test("tipo desconhecido mantém fallback sem virar pedido", () => {
  assert.ok(render("unknown", {}).includes("[unknown]"));
});
