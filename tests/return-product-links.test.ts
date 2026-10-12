import test from "node:test";
import assert from "node:assert/strict";
import { returnProductLinks } from "../lib/return-product-links";
import { elements, loadPage } from "./helpers/page-harness";
import * as display from "../app/central-reclamacoes/case-display";
import * as presentation from "../app/central-reclamacoes/case-presentation";
import * as context from "../lib/marketplace-case-context";

function fixture(marketplace = "shopee") {
  const item = { id: "line", sku: "SKU", scope: "sale", product: { id: "product", sku: "SKU" } };
  const order = marketplace === "shopee"
    ? { order_sn: "order", item_list: [{ item_id: 456, item_sku: "SKU" }] }
    : { id: "order", seller: { id: 123 }, order_items: [{ item: { id: "MLB456", seller_sku: "SKU" } }] };
  const row = { marketplace, marketplace_account_id: "SP-GI", order_id: "order", account: { shop_id: "123", seller_id: "123" },
    sale: { marketplace, order_id: "order", items: [item], raw_data: { marketplace_account_id: "SP-GI", payload: { order } } } };
  return { row, item, order };
}
for (const marketplace of ["shopee", "mercado_livre"]) {
  test(`${marketplace}: exact original seller and listing`, () => {
    const { row, item } = fixture(marketplace);
    assert.deepEqual(returnProductLinks(row, item), { productId: "product", listingUrl: marketplace === "shopee"
      ? "https://shopee.com.br/product/123/456" : "https://produto.mercadolivre.com.br/MLB-456-_JM" });
  });
  test(`${marketplace}: rejects another account, order or sale line`, () => {
    for (const change of [ { marketplace_account_id: "other" }, { order_id: "other" }, { marketplace: "other" } ]) {
      const { row, item } = fixture(marketplace);
      assert.deepEqual(returnProductLinks({ ...row, ...change }, item), { productId: null, listingUrl: null });
    }
    const { row, item } = fixture(marketplace);
    assert.equal(returnProductLinks(row, { ...item, id: "other" }).listingUrl, null);
  });
}
test("same SKU in two listings is ambiguous", () => {
  const { row, item, order } = fixture();
  order.item_list!.push({ item_id: 789, item_sku: "SKU" });
  assert.equal(returnProductLinks(row, item).listingUrl, null);
});
test("original Shopee shop and ML seller must match", () => {
  const shopee = fixture();
  assert.equal(returnProductLinks({ ...shopee.row, account: { shop_id: "" } }, shopee.item).listingUrl, null);
  const ml = fixture("mercado_livre");
  assert.equal(returnProductLinks({ ...ml.row, account: { seller_id: "999" } }, ml.item).listingUrl, null);
});
test("explicit case product remains available without sale; SKU fallback is disabled", () => {
  const { item } = fixture();
  assert.deepEqual(returnProductLinks({}, item), { productId: null, listingUrl: null });
  assert.deepEqual(returnProductLinks({ product: item.product }, { ...item, scope: "case" }), { productId: "product", listingUrl: null });
});

test("collapsed return header renders links outside the expansion toggle, with no drilldown duplicates", () => {
  const { CaseGrid, CaseDetail } = loadPage("app/central-reclamacoes/case-grid.tsx", {
    react: { useState: (v: unknown) => [v, () => {}], useRef: () => ({ current: null }), useCallback: (v: unknown) => v, useEffect() {}, useLayoutEffect() {} },
    "./case-display": display, "./case-presentation": presentation, "@/lib/marketplace-case-context": context,
    "./case-detail-cache": { detailCacheKey: () => "key" },
  });
  for (const marketplace of ["shopee", "mercado_livre"]) for (const available of [true, false]) {
    const { row, item } = fixture(marketplace);
    const data = { row: { ...row, id: "case", case_type: "return", deadlines: [] }, items: [{ ...item, links: available ? returnProductLinks(row, item) : {} }], messages: [], deadlines: [], timeline: [], evidence: [] };
    const tree = CaseGrid({ rows: [{ ...data.row, items: data.items }] });
    const nodes = elements(tree);
    const toggle = nodes.find(n => n.type === "button" && n.props["aria-controls"] === "detail-case");
    assert.equal(toggle.props["aria-expanded"], false);
    assert.equal(elements(toggle).length, 1, "links must not be nested inside a button");
    assert.equal(nodes.some(n => n.props.id === "detail-case"), false);
    assert.equal(elements(CaseDetail({ id: "case", initialData: data })).some(n => ["Ver Produto", "Ver Anúncio"].includes(n.props.children)), false);
    const buttons = nodes.filter(n => ["Ver Produto", "Ver Anúncio"].includes(n.props.children));
    assert.equal(buttons.length, 2);
    for (const button of buttons) {
      assert.equal(button.type, available ? "a" : "button");
      if (available) { assert.equal(button.props.target, "_blank"); assert.equal(button.props.rel, "noopener noreferrer"); }
      else { assert.equal(button.props.disabled, true); assert.equal(button.props.href, undefined); }
    }
  }
});

test("closed cards reuse cached validated links without opening the drilldown", async () => {
  const { row, item } = fixture();
  const states: any[] = [];
  const effects: Array<() => void> = [];
  let index = 0;
  const reads: string[] = [];
  const { CaseGrid } = loadPage("app/central-reclamacoes/case-grid.tsx", {
    react: { useState(value: any) { const position = index++; if (!(position in states)) states[position] = value; return [states[position], (next: any) => { states[position] = typeof next === "function" ? next(states[position]) : next; }]; },
      useCallback: (value: unknown) => value, useEffect: (effect: () => void) => effects.push(effect) },
    "./case-display": display, "./case-presentation": presentation, "@/lib/marketplace-case-context": context,
    "./case-detail-cache": { detailCacheKey: () => "scoped-key", async readCaseCache(key: string, id: string) { reads.push(key + ":" + id); return { items: [{ ...item, links: returnProductLinks(row, item) }] }; } },
  });
  const props = { rows: [{ ...row, id: "case", case_type: "return", items: [item], deadlines: [] }] };
  CaseGrid(props);
  effects.forEach(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  index = 0;
  const nodes = elements(CaseGrid(props));
  assert.deepEqual(reads, ["scoped-key:case"]);
  assert.equal(nodes.filter(n => n.type === "a" && ["Ver Produto", "Ver Anúncio"].includes(n.props.children)).length, 2);
  assert.equal(nodes.find(n => n.props["aria-controls"] === "detail-case").props["aria-expanded"], false);
});
