import assert from "node:assert/strict";
import test from "node:test";
import { buildMercadoLivreStockRequests } from "../lib/marketplace-stock-payloads";

test("estoque zero pausa explicitamente o anuncio", () => {
  assert.deepEqual(buildMercadoLivreStockRequests(0, false), [{ status: "paused" }]);
});

test("reposicao reativa antes de atualizar a quantidade quando a pausa foi automatica", () => {
  assert.deepEqual(buildMercadoLivreStockRequests(4, true), [{ status: "active" }, { available_quantity: 4 }]);
});

test("reposicao respeita pausa manual", () => {
  assert.deepEqual(buildMercadoLivreStockRequests(4, false), [{ available_quantity: 4 }]);
});
