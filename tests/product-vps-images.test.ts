import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activityNeedsProductImages, imageIsAvailable, isVpsImageUrl, mergeRecoveredImages, prepareActivityImageRequest, productImageCandidates, productImageUrl } from "../lib/product-image-source";
import { coverTransformationId, matchesLegacyCoverTreatment, prepareProductMarketplaceImages } from "../lib/product-marketplace-images";

const vps = "https://api.gestaomarketplace.tech/Imagens/Legado/";
const legacy = "https://res.cloudinary.com/test/image/upload/original.jpg";
const bytes = new Uint8Array([1, 2, 3]);
const images = [1, 2, 3].map(position => ({ id: String(position), position, url: `${vps}${position}.jpg`, cloudinary_url: legacy }));
const transformed = (id: string) => `https://res.cloudinary.com/test/image/upload/v1/${id}.jpg`;
function harness(unavailable: string[] = []) {
  const calls = { transforms: 0, persisted: [] as string[], downloads: [] as string[] };
  return { calls, deps: {
    download: async (url: string) => { calls.downloads.push(url); return bytes; },
    available: async (url: string) => Boolean(url) && !unavailable.includes(url),
    transform: async (_bytes: Uint8Array, id: string) => { calls.transforms++; return transformed(id); },
    persist: async (_image: unknown, url: string) => { calls.persisted.push(url); }
  } };
}

test("VPS canonical and transitional originals outrank old transformations; legacy stays compatible", () => {
  assert.equal(productImageUrl(images[0]), images[0].url);
  assert.equal(productImageUrl({ url: legacy, local_url: images[0].url, cloudinary_url: legacy }), images[0].url);
  assert.equal(productImageUrl({ url: legacy }), legacy);
  assert.equal(productImageUrl({ url: "", cloudinary_url: legacy }), legacy);
  assert.equal(productImageUrl(null), "");
  assert.equal(isVpsImageUrl("https://api.gestaomarketplace.tech.attacker.test/Imagens/a.jpg"), false);
});
test("fallback candidates try VPS first and preserve valid original until load fails", () => {
  assert.deepEqual(productImageCandidates({ url: images[0].url, local_url: images[0].url, cloudinary_url: legacy }), [images[0].url, legacy]);
});
test("SKU 1096AU read-only snapshot selects all three VPS originals without rewriting data", () => {
  const snapshot = JSON.parse(readFileSync("docs/image-vps-review/1096AU-before.json", "utf8")) as {
    productionWrites: number; product: { product_images: typeof images }; checks: Array<{ url: string; status: number; contentType: string }>;
  };
  assert.equal(snapshot.productionWrites, 0);
  assert.deepEqual([...snapshot.product.product_images].sort((a, b) => a.position - b.position).map(productImageUrl), snapshot.checks.map(check => check.url));
  assert.ok(snapshot.checks.every(check => check.status === 200 && check.contentType === "image/jpeg"));
});
test("legacy URL treatment evidence reuses same asset and rejects different version or missing treatment", async () => {
  const original = "https://res.cloudinary.com/test/image/upload/v123/produtos/cover.jpg";
  const cover = original.replace("/upload/", "/upload/e_background_removal,b_white/");
  assert.equal(matchesLegacyCoverTreatment(original, cover), true);
  assert.equal(matchesLegacyCoverTreatment(original.replace("v123", "v124"), cover), false);
  assert.equal(matchesLegacyCoverTreatment(original, original), false);
  assert.equal(matchesLegacyCoverTreatment(original.replace("/v123", ""), cover.replace("/v123", "")), false);
  const h = harness();
  const urls = await prepareProductMarketplaceImages([{ position: 1, url: original, cloudinary_url: cover }], h.deps);
  assert.equal(urls[0], cover);
  assert.equal(h.calls.transforms, 0);
  assert.deepEqual(h.calls.downloads, []);
});
test("migrated cover is treated once, positions 2+ use originals in configured order", async () => {
  const h = harness();
  const urls = await prepareProductMarketplaceImages([images[2], images[0], images[1]], h.deps);
  assert.deepEqual(urls.slice(1), [images[1].url, images[2].url]);
  assert.equal(h.calls.transforms, 1);
  assert.deepEqual(h.calls.persisted, [urls[0]]);
});
test("valid cover is reused with evidence of current URL, bytes and required treatment", async () => {
  const h = harness();
  const cover = transformed(coverTransformationId(images[0].url, bytes));
  const urls = await prepareProductMarketplaceImages([{ ...images[0], cloudinary_url: cover }, images[1]], h.deps);
  assert.equal(urls[0], cover);
  assert.equal(h.calls.transforms, 0);
  assert.deepEqual(h.calls.persisted, []);
});
test("changed source bytes invalidate transformation even with same URL", async () => {
  const h = harness();
  const old = transformed(coverTransformationId(images[0].url, new Uint8Array([9])));
  await prepareProductMarketplaceImages([{ ...images[0], cloudinary_url: old }], h.deps);
  assert.equal(h.calls.transforms, 1);
});
test("legacy and mixed sets retain original URLs for photos 2+", async () => {
  for (const input of [
    [{ position: 1, url: legacy }, { position: 2, url: legacy }],
    [images[0], { position: 2, url: legacy }, images[2]],
    [{ ...images[0], url: legacy, local_url: images[0].url }, images[1]]
  ]) {
    const h = harness();
    const urls = await prepareProductMarketplaceImages(input, h.deps);
    assert.equal(urls[1], input[1].url);
  }
});
test("isolated recovery preserves healthy originals, positions and missing slots", () => {
  const replacement = { position: 2, id: "remote" };
  const merged = mergeRecoveredImages(images, [replacement, { position: 5, id: "extra" }]);
  assert.deepEqual(merged, [images[0], replacement, images[2]]);
  assert.deepEqual(mergeRecoveredImages(images, []), images);
});
test("original failure blocks sending instead of using stale transformation or marketplace recovery", async () => {
  const h = harness([images[1].url]);
  await assert.rejects(prepareProductMarketplaceImages(images, h.deps), /Foto 2 indisponível/);
  assert.equal(h.calls.transforms, 0);
});
test("unavailable valid transformation blocks without redundant processing", async () => {
  const cover = transformed(coverTransformationId(images[0].url, bytes));
  const h = harness([cover]);
  await assert.rejects(prepareProductMarketplaceImages([{ ...images[0], cloudinary_url: cover }], h.deps), /transformação da Foto 1 indisponível/);
  assert.equal(h.calls.transforms, 0);
});
test("background removal failure or invalid result never sends untreated cover", async () => {
  const h = harness();
  await assert.rejects(prepareProductMarketplaceImages(images, { ...h.deps, transform: async () => { throw new Error("background failed"); } }), /remover o fundo.*background failed/);
  await assert.rejects(prepareProductMarketplaceImages(images, { ...h.deps, transform: async () => legacy }), /Transformação inválida/);
  assert.deepEqual(h.calls.persisted, []);
});
test("failed persistence blocks sending", async () => {
  const h = harness();
  await assert.rejects(prepareProductMarketplaceImages(images, { ...h.deps, persist: async () => { throw new Error("source changed"); } }), /source changed/);
});
test("reordering prepares new position 1 and ignores its old secondary transformation", async () => {
  const h = harness();
  const urls = await prepareProductMarketplaceImages([{ ...images[1], position: 1 }, { ...images[0], position: 2 }], h.deps);
  assert.deepEqual(h.calls.downloads, [images[1].url]);
  assert.equal(urls[1], images[0].url);
  assert.equal(h.calls.transforms, 1);
});
test("missing cover and duplicate positions block", async () => {
  const h = harness();
  for (const input of [[], [images[1]], [images[0], images[0]]]) await assert.rejects(prepareProductMarketplaceImages(input, h.deps), /Foto 1 e posições únicas/);
});
test("ML and Shopee queued create/update image intents refresh old references; unrelated jobs never publish images", () => {
  for (const destination of ["mercado_livre", "shopee"]) {
    assert.equal(activityNeedsProductImages({ destination, activity_type: "listing_create" }), true);
    assert.equal(activityNeedsProductImages({ destination, activity_type: "listing_update", requested_data: destination === "shopee" ? { imageUrls: [legacy] } : { payload: { pictures: [{ source: legacy }] } } }), true);
    assert.equal(activityNeedsProductImages({ destination, activity_type: "listing_update", requested_data: { payload: { price: 10 } } }), false);
    assert.equal(activityNeedsProductImages({ destination, activity_type: "stock_update" }), false);
  }
  assert.equal(activityNeedsProductImages({ destination: "tiny", activity_type: "listing_create" }), false);
});
test("queued old ML and Shopee payloads receive guarded current images in exact order", async () => {
  const current = [transformed(coverTransformationId(images[0].url, bytes)), images[1].url, images[2].url];
  for (const destination of ["mercado_livre", "shopee"]) {
    for (const activity_type of ["listing_create", "listing_update"]) {
      const requested_data = destination === "mercado_livre" ? { payload: { price: 10, pictures: [{ source: legacy }] } } : { payload: { original_price: 10 }, imageUrls: [legacy] };
      const request = await prepareActivityImageRequest({ destination, activity_type, product_id: "p1", requested_data }, async id => { assert.equal(id, "p1"); return current; });
      assert.deepEqual(destination === "mercado_livre" ? request?.payload.pictures.map((p: { source: string }) => p.source) : request?.imageUrls, current);
      assert.equal(destination === "mercado_livre" ? request?.payload.price : request?.payload.original_price, 10);
    }
  }
  let called = false;
  await prepareActivityImageRequest({ destination: "shopee", activity_type: "listing_update", product_id: "p1", requested_data: { payload: { original_price: 10 } } }, async () => { called = true; return current; });
  assert.equal(called, false);
  await assert.rejects(prepareActivityImageRequest({ destination: "shopee", activity_type: "listing_create" }, async () => current), /sem produto associado/);
});
test("availability uses selected URL, handles unavailable and HEAD-unsupported responses", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push(String(input));
      return new Response(null, { status: init?.method === "HEAD" ? 405 : 200, headers: { "content-type": "image/jpeg" } });
    };
    assert.equal(await imageIsAvailable(images[0].url), true);
    assert.deepEqual(requests, [images[0].url, images[0].url]);
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await imageIsAvailable(images[1].url), false);
    globalThis.fetch = async () => new Response("html", { headers: { "content-type": "text/html" } });
    assert.equal(await imageIsAvailable(images[1].url), false);
  } finally { globalThis.fetch = original; }
});
test("runtime consumers route image intent through guarded policy and preserve sale listing images", () => {
  const publisher = readFileSync("lib/direct-marketplace-publisher.ts", "utf8");
  assert.equal((publisher.match(/await prepareMarketplaceImages\(productId\)/g) || []).length, 2);
  const worker = readFileSync("lib/outgoing-activities.ts", "utf8");
  assert.ok(worker.indexOf("if (activityNeedsProductImages(activity))") < worker.indexOf("await executeAndConfirm(activity)"));
  const persistence = readFileSync("lib/prepare-marketplace-images.ts", "utf8");
  assert.ok(!persistence.includes("enqueue"));
  const sale = readFileSync("app/vendas/page.tsx", "utf8");
  assert.ok(sale.includes("imageUrl: `/api/vendas/"));
  assert.ok(!sale.includes("productImages.get"));
});
