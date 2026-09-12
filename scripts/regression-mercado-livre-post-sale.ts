import assert from "node:assert/strict";
import { canonicalMercadoLivreConversationId, MLB_MESSAGING_AGENT_ID, mercadoLivreMessageResourcePath, normalizeMercadoLivrePostSale, parseMercadoLivreConversationPath } from "../lib/mercado-livre-post-sale";

const seller = "111";
const old = normalizeMercadoLivrePostSale({ message_id: "old-1", resource: "orders", resource_id: "order-1", from: { user_id: "222" }, to: { user_id: seller }, text: { plain: "Texto antigo" }, date_received: "2026-01-01T10:00:00Z" }, seller)[0];
assert.equal(old.orderId, "order-1");
assert.equal(old.text, "Texto antigo");
assert.equal(old.direction, "incoming");

const currentPayload = { conversation_status: { path: "/packs/pack-1/sellers/111" }, messages: [
  { id: "new-1", from: { user_id: "222" }, to: { user_id: seller }, text: "Primeira", message_date: { created: "2026-01-01T10:00:00Z" }, message_resources: [{ name: "packs", id: "pack-1" }, { name: "sellers", id: seller }] },
  { id: "new-2", from: { user_id: "222" }, to: { user_id: seller }, text: "Segunda", message_date: { created: "2026-01-01T11:00:00Z" }, message_resources: [{ name: "packs", id: "pack-1" }, { name: "sellers", id: seller }] }
] };
const current = normalizeMercadoLivrePostSale(currentPayload, seller);
assert.equal(current.length, 2);
assert.equal(current[0].packId, "pack-1");
assert.equal(current[1].sellerId, seller);
assert.equal(canonicalMercadoLivreConversationId(current[0]), canonicalMercadoLivreConversationId(current[1]));
assert.equal(new Set(current.map(message => `ml-message:${message.messageId}`)).size, 2);

assert.equal(mercadoLivreMessageResourcePath("abc"), "/messages/abc");
assert.equal(mercadoLivreMessageResourcePath("/messages/abc"), "/messages/abc");
assert.equal(mercadoLivreMessageResourcePath("messages/abc"), "/messages/abc");
assert.equal(mercadoLivreMessageResourcePath("https://api.mercadolibre.com/messages/abc"), "/messages/abc");

const agent = normalizeMercadoLivrePostSale({ messages: [{ id: "agent-1", from: { user_id: MLB_MESSAGING_AGENT_ID }, to: { user_id: seller }, text: "Agente", message_resources: [{ name: "packs", id: "pack-agent" }, { name: "sellers", id: seller }] }] }, seller)[0];
assert.equal(agent.isMessagingAgent, true);
assert.equal(agent.direction, "incoming");
assert.equal(agent.counterpartyId, MLB_MESSAGING_AGENT_ID);

const outgoing = normalizeMercadoLivrePostSale({ messages: [{ id: "sent-1", from: { user_id: seller }, to: { user_id: "222" }, text: "Resposta" }] }, seller)[0];
assert.equal(outgoing.direction, "outgoing");
assert.equal(outgoing.counterpartyId, "222");

assert.deepEqual(parseMercadoLivreConversationPath("/packs/p1/sellers/s1"), { packId: "p1", sellerId: "s1", conversationType: null });
assert.deepEqual(parseMercadoLivreConversationPath("/packs/p1/sellers/s1/conversations/after_sale"), { packId: "p1", sellerId: "s1", conversationType: "after_sale" });
assert.equal(canonicalMercadoLivreConversationId({ packId: "p1", conversationType: "post_sale" }), "post-sale:p1:post_sale");
assert.throws(() => canonicalMercadoLivreConversationId({}), /pack\/pedido/);

const moderated = normalizeMercadoLivrePostSale({ messages: [{ id: "mod-1", text: "", status: "rejected", message_moderation: { status: "rejected" } }] }, seller)[0];
assert.equal(moderated.status, "rejected");
assert.equal(moderated.moderation?.status, "rejected");

console.log("Regressão de chats pós-compra do Mercado Livre: OK");
