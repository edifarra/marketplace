import assert from "node:assert/strict";
import test from "node:test";
import { normalizeShopeePhilcoPayload } from "../lib/shopee-philco-text";

test("remove pontos e barras apenas dos textos Philco", () => {
  const payload = { item_name: "Placa JUC7.820.00284125 / TV", description: "Produto: JUC7.820.00284125\nMarca: Philco", item_sku: "AB/1.2", price: 10 };
  const output = normalizeShopeePhilcoPayload(payload);
  assert.equal(output.item_name, "Placa JUC782000284125  TV");
  assert.equal(output.description, "Produto: JUC782000284125\nMarca: Philco");
  assert.equal(output.item_sku, "AB/1.2");
  assert.equal(payload.item_name, "Placa JUC7.820.00284125 / TV");
});

test("nao altera outros fabricantes mesmo quando mencionam Philco no titulo", () => {
  const payload = { item_name: "Peça compatível Philco / AOC", description: "Marca: AOC\nModelo: A/B.3" };
  assert.equal(normalizeShopeePhilcoPayload(payload), payload);
});

test("aceita marca explicita ignorando maiusculas", () => {
  const payload = { brand: "PHILCO", item_name: "ABC/123.45", description: "Placa ABC/123.45" };
  assert.equal(normalizeShopeePhilcoPayload(payload).item_name, "ABC12345");
});

test("nao altera payload sem marca confiavel", () => {
  const payload = { item_name: "Philco JUC7.820", description: "JUC7.820" };
  assert.equal(normalizeShopeePhilcoPayload(payload), payload);
});
