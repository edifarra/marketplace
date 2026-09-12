import assert from "node:assert/strict";
import test from "node:test";
import { parsePriceValue } from "../lib/price-value";

test("converte valores monetarios exibidos em pt-BR", () => {
  assert.equal(parsePriceValue("1.234,56"), 1234.56);
  assert.equal(parsePriceValue("R$ 89,90"), 89.9);
});

test("aceita o valor normalizado e rejeita entradas vazias", () => {
  assert.equal(parsePriceValue("1234.56"), 1234.56);
  assert.equal(parsePriceValue(""), null);
  assert.equal(parsePriceValue(null), null);
});
