import test from "node:test";
import assert from "node:assert/strict";
import { elements, loadPage } from "./helpers/page-harness";
import type { CaseFilters } from "../lib/marketplace-case-list";

// Execute the actual page with isolated dependencies: no auth, database or network.
function pageHarness() {
  const inputs: CaseFilters[] = [];
  const loader = {
    CASE_PAGE_SIZE: 30,
    async loadCaseList(input: CaseFilters) {
      assert.equal(typeof (input as any).then, "undefined", "page must resolve searchParams before loading cases");
      inputs.push(input);
      return {
        rows: [], products: [], accounts: [{ id: "account-1", marketplace: "shopee", name: "Test" }],
        filters: { context: "claim", tab: "all", ...input },
        counts: { action: 0, ongoing: 0, closed: 65, unknown: 0 },
        contextCounts: { claim: 65, return: 65 }, total: 65,
        page: Number(input.page || 1), pages: 3,
      };
    },
  };
  const module = loadPage("app/central-reclamacoes/page.tsx", { "@/lib/marketplace-case-list": loader, "@/lib/marketplace-case-read-cache": { caseReadScope: async () => ({ scope: "test-user", revision: "1" }), cachedCaseList: loader.loadCaseList } });
  return { page: module.default, inputs };
}

test("Central waits for asynchronous searchParams and selects Devoluções", async () => {
  const { page, inputs } = pageHarness();
  let resolve!: (value: CaseFilters) => void;
  const pending = page({ searchParams: new Promise<CaseFilters>(done => { resolve = done; }) });
  assert.equal(inputs.length, 0);
  resolve({ context: "return", tab: "all", page: "1" });
  const nodes = elements(await pending);
  assert.equal(inputs[0].context, "return");
  const active = nodes.find(node => node.type === "a" && node.props["aria-current"] === "page" && new URL(node.props.href, "https://test.invalid").searchParams.get("context") === "return");
  assert.ok(active, "Devoluções must be active after resolving the URL parameters");
});

test("Central preserves filters across context, status and pagination links", async () => {
  const { page, inputs } = pageHarness();
  const filters: CaseFilters = { context: "return", tab: "closed", page: "2", search: "Maria & SKU", marketplace: "shopee", account: "account-1", buyer: "123", site: "MLB" };
  const nodes = elements(await page({ searchParams: Promise.resolve(filters) }));
  assert.equal(inputs[0], filters);
  const links = nodes.filter(node => node.type === "a" && node.props.href.startsWith("/central-reclamacoes?"));
  const queries = links.map(node => new URL(node.props.href, "https://test.invalid").searchParams);
  for (const query of queries) {
    for (const key of ["search", "marketplace", "account", "buyer", "site"] as const) assert.equal(query.get(key), filters[key]);
  }
  assert.ok(queries.some(q => q.get("context") === "claim" && q.get("tab") === "closed" && q.get("page") === "1"));
  assert.ok(queries.some(q => q.get("context") === "return" && q.get("tab") === "action" && q.get("page") === "1"));
  assert.ok(queries.some(q => q.get("context") === "return" && q.get("tab") === "closed" && q.get("page") === "3"));
  assert.ok(queries.some(q => q.get("context") === "return" && q.get("tab") === "closed" && q.get("page") === "1"));
  assert.equal(nodes.find(node => node.type === "input" && node.props.name === "context")?.props.value, "return");
  assert.equal(nodes.find(node => node.type === "input" && node.props.name === "search")?.props.defaultValue, filters.search);
});

test("Central keeps Reclamações as the default when URL parameters are absent", async () => {
  const { page, inputs } = pageHarness();
  const nodes = elements(await page({}));
  assert.equal(Object.keys(inputs[0]).length, 0);
  assert.equal(nodes.find(node => node.type === "input" && node.props.name === "context")?.props.value, "claim");
});
