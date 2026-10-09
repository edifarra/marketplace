import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { elements, loadPage, memoryDatabase, textContent } from "./helpers/page-harness";
import { productImageUrl } from "../lib/product-image-source";

type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const sales = ["ORDER-A", "ORDER-B"].map((order_id, i) => ({
    id: `sale-${i}`, order_id, marketplace: "shopee", status_original: "COMPLETED",
    raw_data: {}, created_at: "2026-10-07", updated_at: "2026-10-07",
  }));
  const activity = (i: number, store = "store-1") => ({
    id: `activity-${i}`, order_id: "ORDER-A", marketplace: "shopee", event_type: "orders",
    received_at: "2026-10-07", raw_payload: {}, venda: { raw_data: { marketplace_account_id: store } },
  });
  const db = memoryDatabase({
    venda: sales, venda_item: [{ venda_id: "sale-0", sku: "SKU-A" }, { venda_id: "sale-1", sku: "SKU-B" }],
    marketplace_activities: [...Array.from({ length: 101 }, (_, i) => activity(i)), activity(999, "other-store")],
  });
  const calls: any[][] = [];
  const record = (name: string, result: any) => async (...args: any[]) => { calls.push([name, ...args]); return result; };
  const mocks: Record<string, unknown> = {
    "@/lib/supabase-admin": { supabaseAdmin: () => db },
    "next/cache": { unstable_noStore() {} },
    "next/navigation": { redirect(path: string) { throw new Error(`Unexpected redirect: ${path}`); } },
    "@/lib/auth": { requireMaster: async () => true, isAuthConfigured: () => true, getMissingAuthConfiguration: () => [] },
    "@/lib/price-evaluation": { evaluatePrice: record("evaluatePrice", { marker: "evaluated" }) },
    "@/lib/marketplace-accounts-view": { listMarketplaceAccountViews: async () => [] },
    "@/lib/migration-stock": { getMigrationStockData: record("getMigrationStockData", { accounts: [], rows: [], summary: {}, errors: [] }) },
    "@/lib/google-drive-config": { getGoogleDriveConfigPageData: record("getGoogleDriveConfigPageData", {
      settings: {}, folders: [], editFolder: { id: "folder-1", name: "Folder" }, serverConnection: {},
    }) },
    "@/lib/telegram-notifications": { getTelegramConfig: async () => ({
      timezone: "America/Sao_Paulo", new_sale_start: "09:00", new_sale_end: "18:00", dispatch_check_time: "09:00",
    }) },
    "@/lib/marketplace-activity-labels": { activityDescription: () => "", activityGroup: () => "Orders", activityTypeLabel: () => "Orders" },
    "@/lib/date-time": { formatSaoPauloDateTime: () => "" },
    "@/lib/marketplace-conversation-scope": { CHAT_CONVERSATION_TYPES: ["chat", "question"] },
    "@/lib/marketplace-conversation-view": { prepareConversationRows: (rows: any[]) => rows, sortConversationRows: () => 0 },
    "@/lib/marketplace-conversation-page": { MARKETPLACE_CONVERSATION_PAGE_SIZE: 25, MARKETPLACE_CONVERSATION_PAGE_SELECT: "id", normalizeMarketplaceConversationPagePlan: (value: any) => value },
    "@/lib/shopee-message-product-cards": { enrichShopeeMessageProductCards: async (_db: unknown, rows: any[]) => rows },
    "@/lib/product-action-rules": {}, "@/lib/marketplace-attributes": {}, "@/lib/marketplace-image-validation": {},
    "@/lib/product-image-source": { productImageUrl },
    "@/lib/sales-fulfillment": { deferredShipping: () => null, overduePrintedLabel: () => false,
      saleShippingAction: () => null, saleLabelPrintedAt: () => null, extractSaleShipping: () => ({}) },
  };
  return { db, calls, mocks };
}
function hasQuery(f: Fixture, table: string, method: string, ...args: any[]) {
  assert.ok(f.db.calls.some(c => c.table === table && c.method === method && JSON.stringify(c.args.slice(0, args.length)) === JSON.stringify(args)), `${table}.${method}(${JSON.stringify(args)})`);
}
function field(tree: any, name: string) {
  return elements(tree).find(node => ["input", "select"].includes(node.type) && node.props.name === name)?.props;
}
function messages(tree: any) {
  assert.ok(textContent(tree).includes("Test error"));
  assert.ok(textContent(tree).includes("Test success"));
}

const scenarios: Array<{ route: string; params: Record<string, string>; verify: (tree: any, f: Fixture) => void }> = [
  { route: "avaliacao-preco", params: { busca: "SKU-A", online: "1" }, verify(tree, f) {
    assert.equal(JSON.stringify(f.calls), JSON.stringify([["evaluatePrice", "SKU-A", { forceOnline: true }]]));
    const form = elements(tree).find(n => n.props.initialQuery === "SKU-A");
    assert.equal(form?.props.initialOnline, true);
  } },
  { route: "chats-perguntas", params: { page: "2", tab: "all", marketplace: "shopee", store: "store-1", status: "answered", sla: "outside", search: " SKU-A ", from: "2026-10-01", to: "2026-10-07", unread: "1" }, verify(tree, f) {
    const input = f.db.calls.find(c => c.method === "rpc")!.args[0];
    for (const [key, value] of Object.entries({ p_page: 2, p_tab: "all", p_marketplace: "shopee", p_store: "store-1", p_status: "answered", p_sla: "outside", p_search: "SKU-A", p_from: "2026-10-01", p_to: "2026-10-07", p_unread: true })) assert.equal(input[key], value);
    assert.equal(field(tree, "search")?.defaultValue, "SKU-A");
    assert.equal(field(tree, "unread")?.defaultChecked, true);
    assert.ok(textContent(tree).includes("Página 2"));
  } },
  { route: "atividades-marketplace", params: { page: "2", store: "store-1", order: " order-a ", type: "shopee:orders" }, verify(tree) {
    assert.ok(textContent(tree).includes("Página 2 de 3"));
    const links = elements(tree).filter(n => n.type === "a").map(n => n.props.href);
    assert.ok(links.includes("/atividades-marketplace/activity-50"));
    assert.ok(!links.includes("/atividades-marketplace/activity-0"));
    assert.ok(!links.includes("/atividades-marketplace/activity-999"));
    assert.equal(field(tree, "store")?.defaultValue, "store-1");
    assert.equal(field(tree, "order")?.defaultValue, "order-a");
  } },
  { route: "atividades-marketplace/enviadas", params: { page: "2", sku: "SKU-A", type: "claim_action", store: "store-1", from: "2026-10-01", to: "2026-10-07" }, verify(tree, f) {
    const table = "outgoing_marketplace_activities";
    hasQuery(f, table, "ilike", "sku", "%SKU-A%");
    hasQuery(f, table, "eq", "activity_type", "claim_action");
    hasQuery(f, table, "eq", "marketplace_account_id", "store-1");
    hasQuery(f, table, "gte", "created_at", "2026-10-01T00:00:00-03:00");
    hasQuery(f, table, "lte", "created_at", "2026-10-07T23:59:59-03:00");
    hasQuery(f, table, "range", 50, 99);
    assert.equal(field(tree, "sku")?.defaultValue, "SKU-A");
  } },
  { route: "historico-estoque", params: { busca: "SKU-A", produto: "product-1" }, verify(tree, f) {
    hasQuery(f, "products", "eq", "id", "product-1");
    assert.equal(field(tree, "busca")?.defaultValue, "SKU-A");
  } },
  { route: "integracoes", params: { erro: "Test error", sucesso: "Test success" }, verify: messages },
  { route: "estoque", params: { view: "stock-divergent", status: "paused", stock: "without-stock", erro: "Test error", sucesso: "Test success" }, verify(tree, f) {
    assert.equal(JSON.stringify(f.calls), JSON.stringify([["getMigrationStockData", "stock-divergent", "paused", "without-stock"]]));
    assert.equal(field(tree, "view")?.value, "stock-divergent");
    assert.equal(field(tree, "status")?.defaultValue, "paused");
    assert.equal(field(tree, "stock")?.defaultValue, "without-stock");
    messages(tree);
  } },
  { route: "login", params: { next: "/central-reclamacoes?context=return&tab=all&page=1", sessao: "expirada", erro: "Ignored error" }, verify(tree) {
    assert.equal(field(tree, "next")?.value, "/central-reclamacoes?context=return&tab=all&page=1");
    assert.ok(textContent(tree).includes("Sua sessao expirou"));
    assert.ok(!textContent(tree).includes("Ignored error"));
  } },
  { route: "vendas", params: { orderId: " order-a ", sku: "sku-a" }, verify(tree) {
    const grid = elements(tree).find(n => Array.isArray(n.props.rows));
    assert.equal(grid?.props.rows.length, 1);
    assert.equal(grid?.props.rows[0].id, "sale-0");
    assert.equal(field(tree, "orderId")?.defaultValue, " order-a ");
    assert.equal(field(tree, "sku")?.defaultValue, "sku-a");
  } },
  { route: "produtos", params: { q: " SKU-A ", page: "2", status: "active", marketplace: "tiny_only", brand: "BR", type: "TP", availableStock: "positive", sort: "name", erro: "Test error", sucesso: "Test success", fila: "one,two", aguardando: "Waiting" }, verify(tree, f) {
    const table = "products_with_link_type";
    hasQuery(f, table, "or", "sku.ilike.%SKU-A%,title.ilike.%SKU-A%");
    hasQuery(f, table, "eq", "status", "active");
    hasQuery(f, table, "eq", "integration_link_type", "tiny_only");
    hasQuery(f, table, "eq", "brand_code", "BR");
    hasQuery(f, table, "eq", "type_code", "TP");
    hasQuery(f, table, "gt", "estoque_disponivel", 0);
    hasQuery(f, table, "order", "title", { ascending: true });
    hasQuery(f, table, "range", 100, 199);
    assert.equal(field(tree, "sort")?.defaultValue, "name");
    messages(tree);
    const waiter = elements(tree).find(n => n.props.initialMessage === "Waiting");
    assert.equal(JSON.stringify(waiter?.props.activityIds), JSON.stringify(["one", "two"]));
    const returnTo = new URL(waiter?.props.returnTo, "https://test.invalid");
    assert.equal(returnTo.searchParams.get("q"), "SKU-A");
    assert.equal(returnTo.searchParams.get("page"), "2");
  } },
  { route: "configuracoes/google-drive", params: { q: "Folder", edit: "folder-1", erro: "Test error" }, verify(tree, f) {
    assert.equal(JSON.stringify(f.calls), JSON.stringify([["getGoogleDriveConfigPageData", "Folder", "folder-1"]]));
    assert.equal(field(tree, "q")?.defaultValue, "Folder");
    assert.equal(field(tree, "originalId")?.value, "folder-1");
    assert.ok(textContent(tree).includes("Test error"));
  } },
  { route: "configuracoes/status-vendas", params: { marketplace: "shopee", erro: "Test error", sucesso: "Test success" }, verify(tree, f) {
    hasQuery(f, "status_venda", "eq", "marketplace", "shopee");
    messages(tree);
  } },
  ...["configuracoes/usuarios", "configuracoes/categorias-marketplace", "configuracoes/notificacoes-telegram"].map(route => ({ route, params: { erro: "Test error", sucesso: "Test success" }, verify: messages })),
  ...["mediacoes/anuncios-finalizados", "mediacoes/anuncios-em-revisao"].map((route, i) => ({
    route, params: { page: "2", store: "store-1", marketplace: "shopee", search: " SKU-A " },
    verify(tree: any, f: Fixture) {
      assert.equal(tree.props.classification, i === 0 ? "final" : "review");
      assert.equal(typeof tree.props.searchParams.then, "undefined");
      assert.equal(tree.props.searchParams.page, "2");
      // Execute the shared consumer too, checking the actual queries and links.
      return loadPage("app/mediacoes/listing-moderations-page.tsx", f.mocks).ListingModerationsPage(tree.props).then((listing: any) => {
        const table = "marketplace_listing_moderations";
        hasQuery(f, table, "eq", "classification", i === 0 ? "final" : "review");
        hasQuery(f, table, "eq", "marketplace", "shopee");
        hasQuery(f, table, "eq", "marketplace_account_id", "store-1");
        hasQuery(f, table, "or", "sku.ilike.%SKU-A%,product_name.ilike.%SKU-A%,listing_id.ilike.%SKU-A%");
        hasQuery(f, table, "range", 50, 99);
        assert.equal(field(listing, "search")?.defaultValue, "SKU-A");
      });
    },
  })),
];

for (const scenario of scenarios) {
  test(`${scenario.route}: awaited URL parameters reach filters, navigation and messages`, async () => {
    const f = fixture();
    const page = loadPage(`app/${scenario.route}/page.tsx`, f.mocks).default;
    let resolve!: (params: Record<string, string>) => void;
    const pending = page({ searchParams: new Promise<Record<string, string>>(done => { resolve = done; }) });
    assert.equal(f.db.calls.length, 0, "do not query with unresolved parameters");
    assert.equal(f.calls.length, 0);
    resolve(scenario.params);
    await scenario.verify(await pending, f);
  });
  test(`${scenario.route}: absent URL parameters retain defaults`, async () => {
    const f = fixture();
    const page = loadPage(`app/${scenario.route}/page.tsx`, f.mocks).default;
    const omitted = await page({});
    const empty = await page({ searchParams: Promise.resolve({}) });
    assert.equal(textContent(omitted), textContent(empty));
    assert.equal(JSON.stringify(elements(omitted).filter(n => ["input", "select"].includes(n.type)).map(n => n.props)), JSON.stringify(elements(empty).filter(n => ["input", "select"].includes(n.type)).map(n => n.props)));
  });
}

test("audit covers every route receiving searchParams, including the two already migrated", () => {
  const root = new URL("../app/", import.meta.url);
  const discovered = readdirSync(root, { recursive: true }).map(String).filter(path => /(^|[\\/])page\.tsx$/.test(path))
    .filter(path => /\bsearchParams\b/.test(readFileSync(new URL(path.replaceAll("\\", "/"), root), "utf8")))
    .map(path => path.replaceAll("\\", "/").replace(/\/page\.tsx$/, ""));
  const expected = [...scenarios.map(s => s.route), "central-reclamacoes", "configuracoes/[section]", "produtos/[id]"].sort();
  assert.deepEqual(discovered.sort(), expected);
  for (const route of discovered) {
    const source = ts.createSourceFile(route, readFileSync(new URL(`${route}/page.tsx`, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let contracts = 0;
    function visit(node: ts.Node) {
      if (ts.isPropertySignature(node) && node.name.getText(source) === "searchParams") {
        contracts++;
        assert.ok(node.type && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(source) === "Promise", `${route}: Next.js page prop must be asynchronous`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.equal(contracts, 1, `${route}: audit must find the prop contract`);
  }
});

test("inventory history searches by text when a product is not selected", async () => {
  const f = fixture();
  await loadPage("app/historico-estoque/page.tsx", f.mocks).default({ searchParams: Promise.resolve({ busca: " SKU-A " }) });
  hasQuery(f, "products", "or", "sku.ilike.%SKU-A%,title.ilike.%SKU-A%");
});

test("login displays the error and preserves its default destination", async () => {
  const tree = await loadPage("app/login/page.tsx", fixture().mocks).default({ searchParams: Promise.resolve({ erro: "Invalid login" }) });
  assert.ok(textContent(tree).includes("Invalid login"));
  assert.equal(field(tree, "next")?.value, "/");
});
