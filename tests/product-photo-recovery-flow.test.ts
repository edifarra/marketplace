import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { loadPage, memoryDatabase } from "./helpers/page-harness";
import * as source from "../lib/product-image-source";
import * as processing from "../lib/drive-photo-processing";
import * as policy from "../lib/product-photo-edit-policy";
import * as validation from "../lib/marketplace-image-validation";
import * as bounded from "../lib/bounded-image-download";
import * as marketplaceImages from "../lib/product-marketplace-images";
import * as extractors from "../lib/marketplace-image-recovery";

const old = { id: "old", original_name: "old.jpg", position: 1, url: "https://res.cloudinary.com/dknfrkqol/image/upload/v1/old.jpg" };
const valid = { id: "valid", original_name: "valid.jpg", position: 2, url: "https://api.gestaomarketplace.tech/Imagens/valid.jpg" };
const remote = ["https://market.test/cover.jpg", "https://market.test/secondary.jpg"];
const fixture = () => sharp({ create: { width: 800, height: 600, channels: 3, background: "red" } }).jpeg().toBuffer();

function subject(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const code = readFileSync(path, "utf8");
  const dependencies = Object.fromEntries([...code.matchAll(/from\s+["']([^"']+)["']/g)].map(match => [match[1], {}]));
  const prefix = Object.keys(globals).map(key => `const ${key} = require("test-runtime").${key};`).join("\n");
  return loadPage(path, { ...dependencies, ...mocks, "test-runtime": globals }, prefix + "\n" + code);
}

async function recovery(marketplace: "mercado_livre" | "shopee", available = false, failure = false, linked = true) {
  const image = await fixture();
  const db = memoryDatabase({ product_marketplaces: linked ? [{ marketplace, marketplace_account_id: "a1", marketplace_product_id: "listing1", existe_no_marketplace: true }] : [], config_marketplace_accounts: [{ id: "a1", marketplace, shop_id: "shop1" }] });
  let remoteReads = 0;
  const module = subject("lib/marketplace-temporary-images.ts", {
    "./supabase-admin": { supabaseAdmin: () => db },
    "./product-image-source": { ...source, imageIsAvailable: async (url: string) => url === valid.url || available },
    "./marketplace-image-recovery": extractors,
    "./marketplace-image-validation": validation,
    "./mercado-livre": { getMercadoLivreAccountById: async () => ({}), getMercadoLivreItem: async () => { remoteReads++; if (failure) throw Error("offline"); return { pictures: remote.map(secure_url => ({ secure_url })) }; } },
    "./shopee-oauth": { getShopeeOAuthConfig: async () => ({}), createShopeeClient: () => ({ getProductById: async () => { remoteReads++; if (failure) throw Error("offline"); return { response: { item_list: [{ pictures: remote.map(secure_url => ({ secure_url })) }] } }; } }) },
    "./shopee": { getValidShopeeAccessToken: async () => "test-token" }
  }, { fetch: async () => new Response(image), AbortSignal });
  return { module, db, reads: () => remoteReads };
}

test("available old-account images remain unchanged and never trigger recovery", async () => {
  const h = await recovery("mercado_livre", true);
  assert.equal(await h.module.recoverTemporaryImagesWhenCloudinaryIsUnavailable("p1", [old, valid]), null);
  assert.equal(h.db.calls.length, 0);
  assert.equal(h.reads(), 0);
});

for (const marketplace of ["mercado_livre", "shopee"] as const) {
  test(`${marketplace}: unavailable old-account position recovers; valid secondary is preserved`, async () => {
    const h = await recovery(marketplace);
    const result = await h.module.recoverTemporaryImagesWhenCloudinaryIsUnavailable("p1", [old, valid]);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].position, 1);
    assert.equal(result.images[0].url, remote[0]);
    const merged = source.mergeRecoveredImages([old, valid], result.images);
    assert.equal(merged[1], valid);
    assert.ok(h.db.calls.some(call => call.method === "eq" && call.args[0] === "product_id" && call.args[1] === "p1"));
  });
}

test("failed recovery keeps both original references; foreign listing is rejected before remote access", async () => {
  const h = await recovery("mercado_livre", false, true);
  const images = [old, valid], before = JSON.stringify(images);
  assert.equal(await h.module.recoverTemporaryImagesWhenCloudinaryIsUnavailable("p1", images), null);
  assert.equal(JSON.stringify(images), before);
  const foreign = await recovery("mercado_livre", false, false, false);
  await assert.rejects(() => foreign.module.resolveMarketplaceRecoveryImageUrls({ productId: "p1", marketplace: "mercado_livre", accountId: "foreign", listingId: "other" }));
  assert.equal(foreign.reads(), 0);
  for (const [field, value] of [["product_id", "p1"], ["marketplace", "mercado_livre"], ["marketplace_account_id", "foreign"], ["marketplace_product_id", "other"]]) assert.ok(foreign.db.calls.some(call => call.method === "eq" && call.args[0] === field && call.args[1] === value));
});

async function saveHarness(failure: "download" | "storage" | "database" | "cleanup" | null = null, stock = 1) {
  const image = await fixture();
  const events: string[] = [], replacements: any[] = [], writes: any[] = [], updates: any[] = [], cleanups: any[] = [];
  const secret = "recovery-test-secret";
  const origin = { marketplace: "mercado_livre", accountId: "a1", listingId: "listing1" };
  const recoveryReceipt = policy.signRecoverySequence("p1", [old, valid], [{ key: "0", position: 1 }], origin, secret);
  let rows: any[] = [old, valid];
  const otherProduct = [{ id: "other-image", position: 1, url: "https://other.test/image.jpg" }];
  const db = {
    from(table: string) {
      let single = false;
      const query: any = new Proxy({}, { get(_, method: string) {
        if (method === "then") return (resolve: any) => {
          const data: any = { products: { id: "p1", title: "Board", status: "draft", product_images: rows }, config_types: {}, estoque: { estoque_fisico: stock, estoque_disponivel: stock } };
          return Promise.resolve({ data: single ? data[table] : [], error: null }).then(resolve);
        };
        return (...args: any[]) => { if (["single", "maybeSingle"].includes(method)) single = true; if (["update", "eq"].includes(method)) writes.push({ table, method, args }); return query; };
      } });
      return query;
    },
    rpc(name: string, args: any) { return { throwOnError: async () => {
      assert.equal(name, "replace_product_images_atomically");
      assert.equal(args.p_product_id, "p1");
      events.push("rpc");
      if (failure === "database") throw Error("database unavailable");
      replacements.push(args);
      rows = args.p_images.map((entry: any) => entry.kind === "existing" ? { ...rows.find(row => row.id === entry.id), position: entry.position } : entry);
      return { data: null };
    } }; }
  };
  const module = subject("app/produtos/actions.ts", {
    "next/navigation": { redirect: (url: string) => { throw Error("REDIRECT:" + decodeURIComponent(url)); } },
    "next/cache": { revalidatePath() {} },
    "@vercel/functions": { waitUntil() {} },
    "@/lib/auth": { getCurrentUser: async () => ({ id: "u1" }) },
    "@/lib/supabase-admin": { supabaseAdmin: () => db },
    "@/lib/product-photo-edit-policy": { ...policy,
      verifyPreparedPhoto: (receipt: string, productId: string, userId: string) => policy.verifyPreparedPhoto(receipt, productId, userId, secret),
      recoverySequenceChanged: (receipt: string, productId: string, images: any, sequence: string[], origin: any) => policy.recoverySequenceChanged(receipt, productId, images, sequence, origin, secret) },
    "@/lib/product-image-cleanup": { cleanupRemovedProductImages: async (input: any) => { assert.ok(events.includes("rpc")); cleanups.push(input); if (failure === "cleanup") throw Error("SFTP denied"); } },
    "@/lib/drive-photo-processing": processing,
    "@/lib/vps-image-storage": { storeVpsImage: async () => { events.push("store"); if (failure === "storage") throw Error("storage offline"); } },
    "@/lib/marketplace-image-validation": validation,
    "@/lib/bounded-image-download": bounded,
    "@/lib/price-value": { parsePriceValue: () => 10 },
    "@/lib/marketplace-attributes": { validateRequiredAttributes: () => [] },
    "@/lib/marketplace-temporary-images": { resolveMarketplaceRecoveryImageUrls: async (input: any) => { assert.equal(input.productId, "p1"); return remote; } },
    "@/lib/direct-marketplace-publisher": { enqueueDirectListingUpdates: async (...args: any[]) => { updates.push(args[3]); } },
    "@/lib/inventory": { syncListingsStock: async () => { events.push("stock"); } },
    "@/lib/outgoing-activities": { drainOutgoingActivities: async () => {} }
  }, { console: { error() {} }, structuredClone, crypto: webcrypto, AbortSignal, fetch: async () => failure === "download" ? new Response(null, { status: 503 }) : new Response(image) });
  async function save(order: string, signed = false, manual = false) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ productId: "p1", sku: "sku1", title: "Board", description: "Board description", model: "Model", typeCode: "PP", brandCode: "BR", physicalStock: String(stock), imageOrder: order, recoveryMarketplace: "mercado_livre", recoveryAccountId: "a1", recoveryListingId: "listing1" })) form.set(key, value);
    if (signed) form.set("recoveryReceipt", recoveryReceipt);
    if (manual) {
      const photo = await processing.processAndStoreDrivePhoto({ buffer: image, sourceKey: "product-edit:p1", position: 3 }, async () => {});
      form.set("preparedImages", JSON.stringify([{ key: "manual", receipt: policy.signPreparedPhoto({ ...photo, name: "manual.jpg", productId: "p1", userId: "u1", expiresAt: Date.now() + 60000 }, secret) }]));
    }
    let message = "";
    try { await module.updateProductDetailsAction(form); } catch (error) { message = String(error); }
    return message;
  }
  return { save, events, replacements, writes, updates, cleanups, rows: () => rows, otherProduct };
}

test("signed pure recovery persists without marketplace photos and preserves other update flags", async () => {
  const h = await saveHarness();
  assert.match(await h.save("remote:0,existing:valid", true), /sucesso=/);
  assert.deepEqual(h.events, ["store", "rpc"]);
  assert.equal(h.cleanups.length, 1);
  assert.equal(h.cleanups[0].previous[0].id, "old");
  assert.deepEqual(JSON.parse(JSON.stringify(h.updates)), [{ title: false, price: true, attributes: true, images: false, stock: 1, reactivatePausedOnManualSave: true }]);
});

for (const [label, order, manual] of [
  ["addition", "remote:0,existing:valid,new:manual", true],
  ["removal", "remote:0", false],
  ["reorder", "existing:valid,remote:0", false]
] as const) test(`recovery plus manual ${label} still synchronizes photos`, async () => {
  const h = await saveHarness();
  assert.match(await h.save(order, true, manual), /sucesso=/);
  assert.equal(h.updates[0].images, true);
});

test("zero stock recovery preserves stock-only save; existing broad pending marker is documented", async () => {
  const h = await saveHarness(null, 0);
  assert.match(await h.save("remote:0,existing:valid", true), /sucesso=/);
  assert.deepEqual(h.events, ["store", "rpc", "stock"]);
  assert.deepEqual(h.updates, []);
  assert.ok(h.writes.some(call => call.table === "products" && call.method === "update" && call.args[0].marketplace_update_pending === true));
});

test("cleanup failure reports saved photos with incomplete cleanup instead of success", async () => {
  const h = await saveHarness("cleanup");
  const message = await h.save("remote:0,existing:valid", true);
  assert.match(message, /erro=.*Fotos salvas; limpeza física não concluída.*SFTP denied/);
  assert.doesNotMatch(message, /sucesso=/);
  assert.equal(h.replacements.length, 1);
  assert.equal(h.cleanups.length, 1);
  assert.equal(h.rows()[0].kind, "new");
});

test("save recovers to VPS before atomic replacement; valid photo and other products stay unchanged", async () => {
  const h = await saveHarness();
  assert.match(await h.save("remote:0,existing:valid"), /sucesso=/);
  assert.deepEqual(h.events, ["store", "rpc"]);
  assert.equal(h.rows()[0].position, 1);
  assert.ok(h.rows()[0].url.startsWith(processing.VPS_IMAGE_ORIGIN));
  assert.equal(h.rows()[0].cloudinary_url, null);
  assert.equal(h.rows()[1].url, valid.url);
  assert.equal(h.otherProduct[0].id, "other-image");
  assert.ok(h.writes.filter(call => call.method === "eq" && ["id", "product_id"].includes(call.args[0])).every(call => call.args[1] === "p1"));
  assert.match(await h.save(`existing:valid,existing:${h.rows()[0].id}`), /sucesso=/);
  assert.equal(h.rows()[0].id, "valid");
  assert.deepEqual(h.events, ["store", "rpc", "rpc"]);
});

for (const failure of ["download", "storage", "database"] as const) {
  test(`${failure} failure preserves previous photo links`, async () => {
    const h = await saveHarness(failure);
    assert.match(await h.save("remote:0,existing:valid"), /erro=/);
    assert.deepEqual(h.rows(), [old, valid]);
    assert.equal(h.replacements.length, 0);
    assert.equal(h.cleanups.length, 0);
    if (failure !== "database") assert.equal(h.events.includes("rpc"), false);
  });
}

test("new main photo gets its own white background derivative and preserves secondary URLs", async () => {
  const image = await fixture(), saved: any[] = [];
  const main = { id: "recovered", position: 1, url: processing.VPS_IMAGE_ORIGIN + "recovered.jpg", cloudinary_url: "https://res.cloudinary.com/active/image/upload/old-cover.jpg" };
  const prepared = await marketplaceImages.prepareProductMarketplaceImages([valid, main], {
    available: async () => true, download: async url => { assert.equal(url, main.url); return image; },
    transform: async (_, id) => `https://res.cloudinary.com/active/image/upload/${id}.jpg`,
    persist: async (row, url) => { saved.push({ id: row.id, url }); }
  });
  assert.equal(saved[0].id, "recovered");
  assert.notEqual(prepared[0], main.cloudinary_url);
  assert.equal(prepared[1], valid.url);
});


test("publication adapter allows available old-account source and scopes derivative update to its image", async () => {
  const bytes = await fixture(), calls: any[] = [];
  const db = { from(table: string) {
    let mutation = false;
    const q: any = new Proxy({}, { get(_, method: string) {
      if (method === "then") return (resolve: any) => Promise.resolve({ data: mutation ? [{ id: old.id }] : [old, valid], error: null }).then(resolve);
      return (...args: any[]) => { calls.push({table, method, args}); if (method === "update") mutation = true; return q; };
    }}); return q;
  }};
  const module = subject("lib/prepare-marketplace-images.ts", {
    "./supabase-admin": { supabaseAdmin: () => db },
    "./cloudinary": { uploadMarketplaceCover: async (_: Uint8Array, id: string) => "https://res.cloudinary.com/active/image/upload/" + id + ".jpg" },
    "./product-marketplace-images": marketplaceImages,
    "./product-image-source": { imageIsAvailable: async () => true }
  }, { fetch: async () => new Response(bytes), AbortSignal });
  const urls = await module.prepareMarketplaceImages("p1");
  assert.equal(urls.length, 2);
  assert.equal(urls[1], valid.url);
  assert.ok(calls.some(call => call.method === "eq" && call.args[0] === "product_id" && call.args[1] === "p1"));
  assert.ok(calls.some(call => call.method === "eq" && call.args[0] === "id" && call.args[1] === old.id));
  assert.ok(calls.some(call => call.method === "eq" && call.args[0] === "position" && call.args[1] === 1));
});
