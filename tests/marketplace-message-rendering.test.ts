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

const reminderMessage = {
  id: "reminder", direction: "system", message_type: "out_of_stock_reminder_card", sent_at: "2026-10-07T12:00:00Z",
  raw_data: { message_type: "out_of_stock_reminder_card", source: "server", content: {
    seller_user_id: 20, product_info: { item_id: 22398678635, name: "Placa Inverter Sony", thumb_url: "sg-product-image", sku: "SONY-01", models: [{ model_stock: 1 }] }
  } }
};
test("lembrete reutiliza card compacto e mantém produto, miniatura e dados sem ações", () => {
  const html = renderToStaticMarkup(React.createElement(Message, { row, message: reminderMessage, showItemCard: true }));
  for (const value of ['chat-product-card message-item-card shopee-reminder', 'Lembrete da Shopee', 'Placa Inverter Sony', 'https://cf.shopee.com.br/file/sg-product-image', 'SONY-01', '22398678635', 'Estoque informado: 1', 'Seu produto pode estar sem estoque']) assert.ok(html.includes(value), value);
  for (const value of ['Definir Estoque', 'Responder', '<button', '<details', 'class="chat-message system"']) assert.ok(!html.includes(value), value);
});
test("lembrete sem miniatura ou estoque mantém card informativo", () => {
  const message = { ...reminderMessage, raw_data: { ...reminderMessage.raw_data, content: { seller_user_id: 20, product_info: { item_id: 22398678635, name: "Placa Inverter Sony" } } } };
  const html = renderToStaticMarkup(React.createElement(Message, { row, message, showItemCard: false }));
  assert.ok(html.includes('message-item-card shopee-reminder'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('Estoque informado'));
});
test("card de contexto mantém apresentação e Mercado Livre não recebe lembrete Shopee", () => {
  const html = renderToStaticMarkup(React.createElement(Message, { row, showItemCard: true, message: {
    id: "context", direction: "incoming", text: "Serve nessa TV?", sent_at: "2026-10-07T12:00:00Z",
    shopee_item_card: { image_url: "https://example.test/product.jpg", title: "Placa Sony", sku: "SKU-1", found: true }
  } }));
  assert.ok(html.includes('class="chat-product-card message-item-card"'));
  assert.ok(html.includes('O cliente está perguntando sobre este anúncio/produto'));
  assert.ok(html.includes('Serve nessa TV?'));
  const ml = renderToStaticMarkup(React.createElement(Message, { row: { ...row, marketplace: "mercado_livre" }, message: reminderMessage, showItemCard: false }));
  assert.ok(!ml.includes('shopee-reminder'));
});
