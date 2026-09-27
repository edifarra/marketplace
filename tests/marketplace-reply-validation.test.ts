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

test("texto sem link preserva o comportamento atual", () => {
  assert.deepEqual(validate("shopee", "O produto está disponível e será enviado amanhã."), []);
  assert.match(validate("shopee", "Meu WhatsApp é 11999998888")[0], /telefone\/WhatsApp/);
});
