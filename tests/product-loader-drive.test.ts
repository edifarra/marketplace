import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { loadPage } from "./helpers/page-harness";
import * as processing from "../lib/drive-photo-processing";
import * as persistence from "../lib/drive-product-persistence";

const pipeline = loadPage("lib/pipeline.ts", {});

async function harness() {
  const buffer = await sharp({ create: { width: 200, height: 100, channels: 3, background: "red" } }).png().toBuffer();
  const files = [6, 2, 4, 1, 5, 3].map(n => ({ id: String(n), name: `PPBR_Model_${String(n).padStart(2, "0")}.png`, mimeType: "image/png" }));
  const downloads: string[] = [], stores: string[] = [], moves: string[] = [];
  const state = { existing: null as null | { id: string; sku: string }, failStore: false, failDb: false, failMove: false, rpcCalls: 0, payload: null as any };
  const db = {
    from(table: string) {
      let single = false, mutation = false;
      const query: any = new Proxy({}, { get(_target, method: string) {
        if (method === "then") return (resolve: any) => {
          const rows: Record<string, unknown[]> = {
            products: state.existing ? [state.existing] : [],
            config_types: [{ code: "PP", description: "Board", sku_group: "PP", sku_max: 0 }],
            config_brands: [{ code: "BR", name: "Brand", include_in_title: true }], config_specials: [],
            sku_counters: mutation ? [{ sku_group: "PP" }] : [{ current_number: 0 }],
            settings: [{ value: 1 }], config_marketplace_accounts: [{ id: "account", name: "ML", marketplace: "mercado_livre" }]
          };
          return Promise.resolve({ data: single ? rows[table]?.[0] || null : rows[table] || [], error: null }).then(resolve);
        };
        return () => {
          if (["insert", "update"].includes(method)) { assert.equal(table, "sku_counters"); mutation = true; single = false; }
          if (["single", "maybeSingle"].includes(method)) single = true;
          return query;
        };
      } });
      return query;
    },
    rpc(name: string, args: any) {
      assert.equal(name, "create_drive_product_atomically");
      state.rpcCalls++; state.payload = args;
      return { throwOnError: async () => {
        if (state.failDb) throw new Error("DB unavailable");
        state.existing = { id: "product", sku: String(args.p_product.sku) };
        return { data: { ...state.existing, created: true } };
      } };
    }
  };
  const loader = loadPage("lib/product-loader.ts", {
    "./supabase-admin": { supabaseAdmin: () => db }, "./pipeline": pipeline,
    "./drive-photo-processing": processing, "./drive-product-persistence": persistence,
    "./vps-image-storage": { vpsImageConfig() {}, storeVpsImage: async (name: string) => {
      if (state.failStore && name.includes("/2-")) throw new Error("SFTP unavailable");
      stores.push(name);
    } },
    "./marketplace-attributes": { buildProductMarketplaceSnapshot: async () => ({ categories: {}, attributes: {} }) },
    "./google-drive": {
      listDriveImagesFolderFiles: async () => files,
      downloadDriveFile: async (id: string, limits: any) => { assert.equal(limits.maxBytes, processing.MAX_DRIVE_PHOTO_BYTES); downloads.push(id); return buffer; },
      moveDriveFilesToImagesSubfolder: async (_files: unknown, folder: string) => {
        if (state.failMove) throw new Error("Drive move unavailable");
        moves.push(folder); return { moved: files.length };
      }
    }
  });
  return { state, downloads, stores, moves, load: loader.loadProductsFromDriveImages as () => Promise<any> };
}

test("real loader preserves Drive photo order, pending pricing and draft accounts; retry does not upload again", async () => {
  const h = await harness();
  const result = await h.load();
  assert.equal(result.created, 1);
  assert.deepEqual(h.downloads, ["1", "2", "3", "4", "5", "6"]);
  const payload = h.state.payload;
  assert.equal(payload.p_product.status, "pending_price");
  assert.equal(payload.p_product.price, 0);
  assert.equal(payload.p_accounts[0].id, "account");
  assert.deepEqual(Array.from(payload.p_images, (i: any) => i.drive_file_id), h.downloads);
  assert.ok(payload.p_images.every((i: any) => i.url.startsWith(processing.VPS_IMAGE_ORIGIN) && i.width_px === 200 && i.height_px === 100 && i.bytes > 0));
  assert.deepEqual(h.moves, ["Enviadas"]);
  const retry = await h.load();
  assert.equal(retry.duplicates, 1);
  assert.equal(h.downloads.length, 6);
  assert.equal(h.state.rpcCalls, 1);
});

test("storage and DB failures never move source files, retry completes the product", async () => {
  for (const failure of ["failStore", "failDb"] as const) {
    const h = await harness();
    h.state[failure] = true;
    const result = await h.load();
    assert.equal(result.created, 0);
    assert.equal(result.failed, 1);
    assert.equal(h.state.existing, null);
    assert.equal(h.moves.length, 0);
    if (failure === "failStore") assert.equal(h.state.rpcCalls, 0);
    const firstPath = h.stores[0];
    h.state[failure] = false;
    assert.equal((await h.load()).created, 1);
    assert.ok(h.stores.filter(path => path === firstPath).length >= 2);
  }
});

test("Drive move failure after commit does not create another product or delete final images", async () => {
  const h = await harness(); h.state.failMove = true;
  assert.equal((await h.load()).failed, 1);
  assert.ok(h.state.existing);
  h.state.failMove = false;
  assert.equal((await h.load()).duplicates, 1);
  assert.equal(h.state.rpcCalls, 1);
  assert.equal(h.stores.length, 6);
});

test("creation and editing store VPS originals; cloning and background recovery retain their own flow", () => {
  const edit = readFileSync("app/api/products/images/prepare/route.ts", "utf8");
  assert.match(edit, /processAndStoreDrivePhoto/);
  assert.doesNotMatch(edit, /uploadProductImageToCloudinary/);
  const loader = readFileSync("lib/product-loader.ts", "utf8");
  assert.doesNotMatch(loader, /cloudinary|isMissingColumnError/i);
  for (const file of ["lib/product-cloner.ts", "lib/marketplace-image-recovery.ts"]) {
    assert.match(readFileSync(file, "utf8"), /uploadProductImageToCloudinary/);
  }
});
