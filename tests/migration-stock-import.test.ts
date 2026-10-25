import assert from "node:assert/strict";
import test from "node:test";
import { loadPage } from "./helpers/page-harness";

function fixture(existing = false, mode: string | null = "TINY", links = true) {
  const writes: Array<{ table: string; method: string; value: any }> = [];
  const reads: string[] = [];
  let product: any = existing ? { id: "p1", sku: "SKU-A", tiny_product_id: "old-tiny" } : null;
  let tinyCalls = 0;
  const marketplaceRows = ["mercado_livre", "shopee"].map((marketplace, i) => ({
    id: `link-${i}`, sku: "SKU-A", marketplace, marketplace_account_id: `account-${i}`,
    marketplace_product_id: `remote-${i}`, titulo_marketplace: "Marketplace title",
    valor_marketplace: 42, estoque_marketplace: i + 3, status_anuncio: "active",
    existe_no_marketplace: true,
  }));
  const db = { from(table: string) {
    reads.push(table);
    let single = false, mutation = "", value: any;
    const query: any = new Proxy({}, { get(_target, method: string) {
      if (method === "then") return (resolve: any, reject: any) => {
        let data: any = [];
        if (mutation) {
          writes.push({ table, method: mutation, value });
          if (table === "products" && mutation === "insert") product = { id: "p1", ...value };
          data = table === "products" ? product : null;
        } else if (table === "products") data = product;
        else if (table === "product_marketplaces") data = links ? marketplaceRows : [];
        else if (table === "settings") data = mode ? { value: mode } : null;
        else if (table === "config_types" || table === "config_brands") data = { code: "AA" };
        else data = single ? null : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return (...args: any[]) => {
        if (["insert", "update", "delete", "upsert"].includes(method)) { mutation = method; value = args[0]; }
        if (["single", "maybeSingle"].includes(method)) single = true;
        return query;
      };
    } });
    return query;
  } };
  const forbiddenTiny = () => { tinyCalls++; throw new Error("Tiny must not be called"); };
  const mocks: Record<string, any> = {
    "./supabase-admin": { supabaseAdmin: () => db },
    "./mercado-livre": { isMercadoLivreInactive: () => false, getActiveMercadoLivreAccounts: async () => [] },
    "./shopee": { getActiveShopeeAccounts: async () => [] },
    "./tiny": { findTinyProductBySku: forbiddenTiny, getTinyProductSnapshot: forbiddenTiny },
    "./product-integration-status": { reconcileProductIntegrationStatus: async () => true, clearTinyLink: forbiddenTiny },
    "./marketplace-attributes": { ensureProductMarketplaceCategoryFallbacks: async () => {} },
  };
  const migration = loadPage("lib/migration-stock.ts", mocks);
  mocks["./migration-stock"] = migration;
  const point = loadPage("lib/product-point-sync.ts", mocks);
  return { migration, point, writes, reads, tinyCalls: () => tinyCalls, product: () => product };
}

for (const mode of ["TINY", "MARKETPLACE_DIRETO", null]) {
  test(`cadastro importa ML e Shopee sem Tiny (modo ${mode})`, async () => {
    const f = fixture(false, mode);
    await f.migration.importMarketplaceSku(" sku-a ");
    assert.equal(f.tinyCalls(), 0);
    assert.equal(f.product().sku, "SKU-A");
    assert.equal(f.product().title, "Marketplace title");
    assert.equal(f.product().price, 42);
    assert.equal(f.product().stock, 4);
    assert.equal(f.product().source_key, "marketplace_SKU-A");
    assert.equal(f.product().tiny_product_id, null);
    assert.equal(f.product().sent_target, null);
    const listings = f.writes.filter(w => w.table === "listings");
    assert.deepEqual(listings.map(w => w.value.marketplace), ["mercado_livre", "shopee"]);
    assert.ok(listings.every(w => w.value.product_id === "p1" && w.value.external_sku === "SKU-A"));
  });
  test(`sincronismo que cadastra SKU novo nao reintroduz Tiny (modo ${mode})`, async () => {
    const f = fixture(false, mode);
    await f.point.synchronizeProductBySku(" sku-a ");
    assert.equal(f.tinyCalls(), 0);
    assert.equal(f.product().tiny_product_id, null);
    assert.equal(f.writes.filter(w => w.table === "products" && w.method === "insert").length, 1);
  });
}

test("SKU existente preserva vinculo Tiny e apenas associa os marketplaces", async () => {
  const f = fixture(true);
  await f.migration.importMarketplaceSku("SKU-A");
  assert.equal(f.tinyCalls(), 0);
  assert.equal(f.product().tiny_product_id, "old-tiny");
  assert.equal(f.writes.filter(w => w.table === "products").length, 0);
  assert.equal(f.writes.filter(w => w.table === "listings").length, 2);
});

test("SKU ausente nas integracoes falha sem chamar Tiny ou escrever", async () => {
  const f = fixture(false, "TINY", false);
  await assert.rejects(f.migration.importMarketplaceSku("MISSING"), /SKU nao encontrado/);
  assert.equal(f.tinyCalls(), 0);
  assert.equal(f.writes.length, 0);
});

test("MARKETPLACE_DIRETO nao consulta Tiny para SKU existente vinculado", async () => {
  const f = fixture(true, "MARKETPLACE_DIRETO");
  await f.point.synchronizeProductBySku("SKU-A");
  assert.equal(f.tinyCalls(), 0);
  assert.equal(f.product().tiny_product_id, "old-tiny");
});

test("acao Cadastrar executa a importacao real sem Tiny e revalida as telas", async () => {
  const f = fixture();
  const paths: string[] = [];
  const actions = loadPage("app/estoque/actions.ts", {
    "@/lib/migration-stock": f.migration,
    "@/lib/product-point-sync": f.point,
    "next/cache": { revalidatePath: (path: string) => paths.push(path) },
    "next/navigation": { redirect: (path: string) => { throw new Error(path); } },
  });
  const form = new FormData(); form.set("sku", " sku-a ");
  await assert.rejects(actions.importMarketplaceSkuAction(form), /sucesso=/);
  assert.equal(f.tinyCalls(), 0);
  assert.equal(f.product().sku, "SKU-A");
  assert.deepEqual(paths, ["/estoque", "/produtos"]);
});
