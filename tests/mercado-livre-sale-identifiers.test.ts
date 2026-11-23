import assert from "node:assert/strict";
import test from "node:test";
import { extractMercadoLivreSaleIdentifiers } from "../lib/mercado-livre-sale-identifiers";

test("extracts order, pack, shipment, all payments and complementary IDs", () => {
  assert.deepEqual(extractMercadoLivreSaleIdentifiers({
    id: 2000019390390724,
    pack_id: 2000015910289801,
    shipping: { id: 48452254311 },
    payments: [{ id: 187208629737 }, { id: 187208629738 }],
    cart: { id: "cart-1" },
    context: { id: "context-1" }
  }), [
    { identifierType: "ORDER_ID", identifierValue: "2000019390390724" },
    { identifierType: "PACK_ID", identifierValue: "2000015910289801" },
    { identifierType: "SHIPPING_ID", identifierValue: "48452254311" },
    { identifierType: "PAYMENT_ID", identifierValue: "187208629737" },
    { identifierType: "PAYMENT_ID", identifierValue: "187208629738" },
    { identifierType: "CART_ID", identifierValue: "cart-1" },
    { identifierType: "CONTEXT_ID", identifierValue: "context-1" }
  ]);
});

test("rejects non-scalar or numerically imprecise identifiers and retains exact textual IDs", () => {
  assert.deepEqual(extractMercadoLivreSaleIdentifiers({
    id: "9007199254740993", pack_id: {}, shipping: {id: true},
    payments: [{id: Number.MAX_SAFE_INTEGER + 1}, {id: NaN}, {id: -1}, {id: "exact-payment"}]
  }), [
    {identifierType: "ORDER_ID", identifierValue: "9007199254740993"},
    {identifierType: "PAYMENT_ID", identifierValue: "exact-payment"}
  ]);
});

test("does not invent missing IDs and deduplicates repeated official identifiers", () => {
  assert.deepEqual(extractMercadoLivreSaleIdentifiers({
    id: 2000019185840280, shipping: { id: 48356063630 }, payments: [{ id: 185223598025 }, { id: 185223598025 }]
  }), [
    { identifierType: "ORDER_ID", identifierValue: "2000019185840280" },
    { identifierType: "SHIPPING_ID", identifierValue: "48356063630" },
    { identifierType: "PAYMENT_ID", identifierValue: "185223598025" }
  ]);
});
