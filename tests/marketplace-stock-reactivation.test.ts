import assert from "node:assert/strict";
import test from "node:test";
import { buildMercadoLivreStockRequests, shouldReactivateMercadoLivreListing } from "../lib/marketplace-stock-payloads";

test("estoque zero pausa explicitamente o anuncio", () => {
  assert.deepEqual(buildMercadoLivreStockRequests(0, false), [{ status: "paused" }]);
});

test("reposicao reativa antes de atualizar a quantidade quando a pausa foi automatica", () => {
  assert.deepEqual(buildMercadoLivreStockRequests(4, true), [{ status: "active" }, { available_quantity: 4 }]);
});

test("reposicao respeita pausa manual", () => {
  assert.deepEqual(buildMercadoLivreStockRequests(4, false), [{ available_quantity: 4 }]);
});

test("salvar manualmente nos detalhes autoriza reativar qualquer anuncio pausado com saldo", () => {
  assert.equal(shouldReactivateMercadoLivreListing({ stock: 2, reactivatePausedOnManualSave: true, reactivateIfStockControlled: false }, "paused"), true);
});

test("salvar manualmente com estoque zero nao reativa", () => {
  assert.equal(shouldReactivateMercadoLivreListing({ stock: 0, reactivatePausedOnManualSave: true }, "paused"), false);
});

test("salvar manualmente nao tenta reativar anuncio que ja esta ativo", () => {
  assert.equal(shouldReactivateMercadoLivreListing({ stock: 2, reactivatePausedOnManualSave: true }, "active"), false);
});

test("fluxo automatico continua respeitando a flag de pausa por estoque", () => {
  assert.equal(shouldReactivateMercadoLivreListing({ stock: 2, reactivateIfStockControlled: false }, "paused"), false);
  assert.equal(shouldReactivateMercadoLivreListing({ stock: 2, reactivateIfStockControlled: true }, "paused"), true);
});
