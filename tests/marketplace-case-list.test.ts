import test from "node:test";
import assert from "node:assert/strict";
import { caseGroup, caseSaleItems, knownCaseDeadlines } from "../lib/marketplace-case-list";

test("NULL/false action flags never become true merely because a case is open", () => {
  for (const needs_action of [null, false, undefined]) {
    assert.equal(caseGroup({ marketplace: "mercado_livre", status: "open", needs_action }), "ongoing");
    assert.equal(caseGroup({ marketplace: "mercado_livre", status: "opened", needs_action }), "ongoing");
    assert.equal(caseGroup({ marketplace: "mercado_livre", status: null, needs_action }), "unknown");
  }
  assert.equal(caseGroup({ marketplace: "shopee", status: null, needs_action: true }), "action");
});
test("terminal case statuses override stale action flags, unknown statuses stay unknown", () => {
  assert.equal(caseGroup({ marketplace: "mercado_livre", status: "closed", needs_action: true }), "closed");
  assert.equal(caseGroup({ marketplace: "shopee", status: "CANCELLED", needs_action: null }), "closed");
  assert.equal(caseGroup({ marketplace: "shopee", status: "new_unrecognized_status", needs_action: null }), "unknown");
  assert.equal(caseGroup({ marketplace: "mercado_livre", status: "delivered", needs_action: null }), "unknown");
});
test("sale items remain sale context and are never selected as the affected case item", () => {
  const products = [{ id: "p", sku: "A", title: "Product A" }];
  const row = { marketplace: "shopee", order_id: "o", sale: { id: "s", marketplace: "shopee", order_id: "o", items: [{ id: "i1", sku: "A" }, { id: "i2", sku: "B" }] } };
  const items = caseSaleItems(row, products);
  assert.equal(items.length, 2);
  assert.ok(items.every((i: any) => i.scope === "sale"));
  assert.equal(items[0].product.id, "p");
  assert.equal(items[1].product, undefined);
  assert.equal(caseSaleItems({ ...row, sale: { ...row.sale, marketplace: "mercado_livre" } }, products).length, 0);
  assert.equal(caseSaleItems({ ...row, order_id: "different" }, products).length, 0);
});
test("explicit item association must belong to the linked sale", () => {
  const row = { marketplace: "shopee", sale: { id: "s", marketplace: "shopee", items: [] }, item: { id: "i", venda_id: "other", sku: "A" } };
  assert.deepEqual(caseSaleItems(row, []), []);
  assert.equal(caseSaleItems({ ...row, item: { ...row.item, venda_id: "s" } }, [])[0].scope, "case");
  assert.equal(caseSaleItems({ ...row, sale: null }, [])[0].scope, "case");
});
test("only known-purpose deadlines from the current observation are shown", () => {
  const timestamp = "2026-10-05T03:00:00Z";
  const deadlines = [
    { purpose: "unknown", value: timestamp, precision: "timestamp", validity: "observed" },
    { purpose: "buyer_return_shipping", value: timestamp, precision: "timestamp", validity: "observed", responsible: "buyer" },
    { purpose: "action:reply", value: timestamp, precision: "timestamp", validity: "observed", responsible: "seller" },
    { purpose: "action:reply", value: "invalid", precision: "unknown", validity: "observed" },
    { purpose: "buyer_return_shipping", value: timestamp, precision: "timestamp", validity: "expired" }
  ];
  const row = { snapshot_order_at: timestamp, observations: [{ order_at: timestamp, deadlines }] };
  const shown = knownCaseDeadlines(row);
  assert.equal(shown.length, 2);
  assert.equal(shown[0].responsible, "buyer");
  assert.equal(shown[0].value, timestamp);
  assert.deepEqual(knownCaseDeadlines({ ...row, snapshot_order_at: "2026-10-06T03:00:00Z" }), []);
});
