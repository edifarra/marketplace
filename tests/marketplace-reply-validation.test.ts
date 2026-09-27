import assert from "node:assert/strict";
import test from "node:test";
import { validateMarketplaceReply } from "../lib/marketplace-reply-validation";

const validate = (marketplace: "shopee" | "mercado_livre", text: string) =>
  validateMarketplaceReply(text, { marketplace, conversation_type: "chat" }).blocked;

test("Shopee permite links oficiais da Shopee", () => {
  assert.deepEqual(validate("shopee", "Veja https://shopee.com.br/product/123/456"), []);
  assert.deepEqual(validate("shopee", "Veja https://s.shopee.com.br/AbCd12"), []);
});

test("Shopee bloqueia links do Mercado Livre e de terceiros", () => {
  assert.match(validate("shopee", "https://produto.mercadolivre.com.br/MLB-123")[0], /links externos/);
  assert.match(validate("shopee", "https://example.com/produto")[0], /links externos/);
});

test("Mercado Livre permite links oficiais do Mercado Livre", () => {
  assert.deepEqual(validate("mercado_livre", "Veja https://produto.mercadolivre.com.br/MLB-123"), []);
  assert.deepEqual(validate("mercado_livre", "Veja www.mercadolivre.com.br/p/MLB123"), []);
  assert.deepEqual(validate("mercado_livre", "Veja https://produto.mercadolivre.com.br/MLB-1234567890-98765432101"), []);
});

test("IDs numéricos em URLs oficiais não são tratados como telefone", () => {
  const officialUrl = "https://shopee.com.br/product/329326155/22899385215";
  assert.deepEqual(validate("shopee", officialUrl), []);
  assert.deepEqual(validate("shopee", `Veja ${officialUrl}`), []);
});

test("telefone fora de uma URL oficial continua bloqueado", () => {
  const blocked = validate("shopee", "Veja https://shopee.com.br/product/329326155/22899385215 meu WhatsApp é 11999998888");
  assert.match(blocked[0], /telefone\/WhatsApp/);
  assert.match(validate("shopee", "11999998888")[0], /telefone\/WhatsApp/);
});

test("Mercado Livre bloqueia links da Shopee e de terceiros", () => {
  assert.match(validate("mercado_livre", "https://shopee.com.br/product/123/456")[0], /links externos/);
  assert.match(validate("mercado_livre", "https://example.com/produto")[0], /links externos/);
});

test("domínios parecidos ou com o oficial apenas no caminho são bloqueados", () => {
  assert.match(validate("shopee", "https://shopee.com.br.evil.com/produto")[0], /links externos/);
  assert.match(validate("mercado_livre", "https://mercadolivre.com.br.evil.com/produto")[0], /links externos/);
  assert.match(validate("shopee", "https://evil.com/shopee.com.br/produto")[0], /links externos/);
});

test("URL externa com números continua bloqueada pela regra de link", () => {
  const blocked = validate("shopee", "https://example.com/product/329326155/22899385215");
  assert.match(blocked[0], /links externos/);
});

test("texto sem link preserva o comportamento atual", () => {
  assert.deepEqual(validate("shopee", "O produto está disponível e será enviado amanhã."), []);
  assert.match(validate("shopee", "Meu WhatsApp é 11999998888")[0], /telefone\/WhatsApp/);
});
