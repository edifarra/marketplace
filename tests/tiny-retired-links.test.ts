import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activeTinyProductId } from "../lib/tiny-product-link";
import { loadPage, memoryDatabase, textContent } from "./helpers/page-harness";

const retired = { id: "product-1130au", sku: "1130AU", sent_target: "TINY", tiny_product_id: null,
  sent_at: "2025-01-01", listings: [] };
function load(path: string, mocks: Record<string, any>, expose = "") {
  const source = readFileSync(path, "utf8");
  const dependencies: Record<string, any> = {};
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (match[1].startsWith("@/lib/")) dependencies[match[1]] = {};
  }
  return loadPage(path, { ...dependencies, "./tiny-product-link": { activeTinyProductId },
    "@/lib/tiny-product-link": { activeTinyProductId }, ...mocks }, source + expose);
}

test("1130AU: legacy marker and historical result cannot supply an operational Tiny ID", () => {
  assert.equal(activeTinyProductId({ ...retired, tiny_product_id: null }), "");
  assert.equal(activeTinyProductId({ tiny_product_id: " 12345 " }), "12345");
});

test("1130AU: product logos hide retired Tiny while preserving ML/Shopee", () => {
  const page = load("app/produtos/page.tsx", { "next/cache": {} }, "\nexport { MarketplaceLogos };");
  const product = { ...retired, listings: [{ id: "ml", marketplace: "mercado_livre", external_listing_id: "MLB1" },
    { id: "shopee", marketplace: "shopee", external_listing_id: "SH1" }] };
  const tree = page.MarketplaceLogos({ product });
  assert.ok(!textContent(tree).includes("OlistTiny"));
  assert.ok(JSON.stringify(tree).includes("MLB1"));
  assert.ok(JSON.stringify(tree).includes("SH1"));
  assert.ok(textContent(page.MarketplaceLogos({ product: { ...retired, tiny_product_id: "123" } })).includes("OlistTiny"));
});

test("1130AU: detail operational rows exclude retired Tiny and retain current integrations", () => {
  const page = load("app/produtos/[id]/page.tsx", {}, "\nexport { buildIntegrationRows };");
  const rows = page.buildIntegrationRows({ ...retired, listings: [
    { id: "ml", marketplace: "mercado_livre", external_listing_id: "MLB1" },
    { id: "sh", marketplace: "shopee", external_listing_id: "SH1" }] });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row: any) => row.integration !== "TINY"));
  assert.equal(page.buildIntegrationRows({ ...retired, tiny_product_id: "123" })[0].code, "123");
});

test("1130AU: deletion inspection never reads history or calls Tiny for a retired link", async () => {
  const db = memoryDatabase({ products: [retired], estoque: [{ estoque_fisico: 10, estoque_disponivel: 10 }],
    settings: [{ value: { idProduto: "historic-id" } }] });
  const product = load("lib/products.ts", { "./supabase-admin": { supabaseAdmin: () => db },
    "next/cache": {}, "next/navigation": {},
    "./tiny": { getTinyProductById() { throw Error("Tiny must not be called"); } } });
  assert.equal((await product.inspectProductDeletion(retired.id)).status, "ready");
  assert.ok(!db.calls.some(call => call.table === "settings"));
});

test("1130AU: integration removal is an idempotent no-op without current Tiny ID", async () => {
  const db = memoryDatabase({ products: [retired], settings: [{ value: { idProduto: "historic-id" } }] });
  const sender = load("lib/product-sender.ts", { "./supabase-admin": { supabaseAdmin: () => db } });
  for (const deleteExternal of [true, false]) assert.equal((await sender.removeProductIntegration(retired.id, "TINY", deleteExternal)).ok, true);
  assert.ok(!db.calls.some(call => call.table === "settings" || call.table === "outgoing_marketplace_activities"));
});

test("1130AU: queued Tiny deletes, updates and stock changes skip retired IDs", async () => {
  const db = memoryDatabase({ products: [retired] });
  const queue = load("lib/outgoing-activities.ts", { "./supabase-admin": { supabaseAdmin: () => db } },
    "\nexport { executeAndConfirm };");
  for (const activity_type of ["listing_delete", "listing_update", "stock_update"]) {
    const result = await queue.executeAndConfirm({ destination: "tiny", activity_type,
      product_id: retired.id, listing_id: "historical-id" });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "retired_tiny_link");
  }
});

test("1130AU: detail shows historical Tiny separately after marker cleanup", async () => {
  const db = memoryDatabase({ products: [{ ...retired, sent_target: null, type_code: "AA", brand_code: "BB", product_images: [] }],
    settings: [{ key: `TINY_LEGACY_LINK_${retired.id}`, value: { sent_target: "TINY" } }] });
  const page = load("app/produtos/[id]/page.tsx", {
    "@/lib/supabase-admin": { supabaseAdmin: () => db },
    "@/lib/marketplace-temporary-images": { recoverTemporaryImagesWhenCloudinaryIsUnavailable: async () => [] },
    "@/lib/dynamic-product-description": { buildProductDescription: () => "Description" },
    "@/lib/product-action-rules": { getProductActionState: () => ({ showSend: true }) },
    "@/lib/effective-product": { resolveEffectiveProduct: () => ({}) },
  });
  const tree = await page.default({ params: Promise.resolve({ id: retired.id }) });
  const text = textContent(tree);
  assert.ok(text.includes("Histórico de envios"));
  assert.ok(text.includes("Integração aposentada — sem vínculo operacional ativo."));
  assert.ok(text.includes("Nenhuma integração operacional ativa."));
  assert.ok(!text.includes("Reenviar/Atualizar"));
});

test("Tiny queue preserves future active links and rejects a replaced ID", async () => {
  let tinyCalls = 0;
  const db = memoryDatabase({ products: [{ ...retired, tiny_product_id: "new-active-id" }] });
  const queue = load("lib/outgoing-activities.ts", { "./supabase-admin": { supabaseAdmin: () => db },
    "./tiny": { deactivateTinyProductById: async (id: string) => { assert.equal(id, "new-active-id"); tinyCalls++; } } },
    "\nexport { executeAndConfirm };");
  const activity = { destination: "tiny", activity_type: "listing_delete", product_id: retired.id, listing_id: "historical-id" };
  assert.equal((await queue.executeAndConfirm(activity)).skipped, true);
  assert.equal((await queue.executeAndConfirm({ ...activity, listing_id: "new-active-id" })).deleted, true);
  assert.equal(tinyCalls, 1);
});

test("1130AU: point synchronization does not search Tiny by SKU to recreate retired links", async () => {
  const db = memoryDatabase({ products: [retired], settings: [{ value: "TINY" }] });
  const sync = load("lib/product-point-sync.ts", { "./supabase-admin": { supabaseAdmin: () => db },
    "./tiny": { findTinyProductBySku() { throw Error("Retired SKU must not be searched in Tiny"); } },
    "./mercado-livre": { getActiveMercadoLivreAccounts: async () => [] },
    "./shopee": { getActiveShopeeAccounts: async () => [] },
    "./marketplace-attributes": { ensureProductMarketplaceCategoryFallbacks: async () => {} },
    "./product-integration-status": { reconcileProductIntegrationStatus: async () => true },
  }, "\nwritePointSyncLog = async () => {};" );
  const result = await sync.synchronizeProductById(retired.id);
  assert.equal(result.errors.length, 0);
  assert.equal(result.tinyFields.length, 0);
});

test("1130AU: full product deletion never enqueues a Tiny operation from historical ID", async () => {
  const writes: string[] = [];
  const db = { from(table: string) {
    assert.notEqual(table, "settings", "Deletion must not recover historical Tiny IDs");
    let mutation = "";
    const query: any = new Proxy({}, { get(_target, method: string) {
      if (method === "then") return (resolve: any, reject: any) => {
        if (mutation) writes.push(`${table}:${mutation}`);
        const data = table === "products" ? { ...retired, source_key: "SOURCE-1130AU", product_images: [] }
          : table === "estoque" ? { estoque_fisico: 10, estoque_disponivel: 10 }
          : table === "outgoing_marketplace_activities" ? null : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return () => { if (["update", "insert", "upsert", "delete"].includes(method)) mutation = method; return query; };
    } });
    return query;
  } };
  const product = load("lib/products.ts", {
    "./supabase-admin": { supabaseAdmin: () => db },
    "next/cache": { revalidatePath() {} },
    "next/navigation": { redirect(path: string) { throw Error(`REDIRECT:${path}`); } },
    "./tiny": { getTinyProductById() { throw Error("Forbidden Tiny read"); } },
    "./local-images": { deleteLocalProductFolder: async () => {} },
    "./outgoing-activities": { drainOutgoingActivities: async () => {}, enqueueOutgoingActivity() { throw Error("Forbidden Tiny enqueue"); } },
  });
  const form = new FormData(); form.set("productId", retired.id);
  await assert.rejects(product.deleteProductById(form), /REDIRECT:\/produtos$/);
  assert.ok(writes.includes("products:delete"));
});

test("1130AU: stock mismatch still blocks deletion without contacting Tiny", async () => {
  const db = memoryDatabase({ products: [retired], estoque: [{ estoque_fisico: 10, estoque_disponivel: 9 }] });
  const product = load("lib/products.ts", { "./supabase-admin": { supabaseAdmin: () => db }, "next/cache": {}, "next/navigation": {} });
  assert.equal((await product.inspectProductDeletion(retired.id)).status, "stock_mismatch");
});
