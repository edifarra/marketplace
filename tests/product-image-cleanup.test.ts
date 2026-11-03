import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanupRemovedProductImages, ownedImagePath } from "../lib/product-image-cleanup";
import { photoDigest, VPS_IMAGE_ORIGIN } from "../lib/drive-photo-processing";

const source = photoDigest(Buffer.from("product-edit:p1"));
const relative = `produtos/${source.slice(0, 2)}/${source}/1-${photoDigest(Buffer.from("jpeg"))}.jpg`;
const old = { id: "old", position: 1, url: VPS_IMAGE_ORIGIN + relative };
const kept = { id: "kept", position: 2, url: "https://external.test/kept.jpg" };
const final = [{ id: "kept", position: 1 }];

function harness(options: { shared?: boolean; confirmation?: boolean; queryFailure?: boolean; deletionFailure?: boolean } = {}) {
  const calls: string[] = [], deleted: string[] = [];
  const db = { from(table: string) {
    assert.equal(table, "product_images");
    let reference = false;
    const q: any = {
      select() { return q; },
      eq(field: string, value: string) { assert.equal(field, "product_id"); assert.equal(value, "p1"); return q; },
      or(filter: string) { assert.ok(filter.includes(`local_path.eq.${relative}`)); reference = true; return q; },
      limit(value: number) { assert.equal(value, 1); return q; },
      async throwOnError() {
        calls.push(reference ? "references" : "confirmation");
        if (options.queryFailure) throw Error("database offline");
        return { data: reference ? (options.shared ? [{ id: "shared" }] : []) : (options.confirmation === false ? [old, kept] : final) };
      }
    }; return q;
  } } as unknown as SupabaseClient;
  const remove = async (file: string) => { calls.push("unlink"); if (options.deletionFailure) throw Error("SFTP denied"); deleted.push(file); };
  const run = (previous = [old, kept], next = final) => cleanupRemovedProductImages({ db, productId: "p1", previous, final: next }, remove);
  return { run, calls, deleted };
}

test("confirmed removal checks global references before deleting only the removed managed photo", async () => {
  const h = harness(); await h.run();
  assert.deepEqual(h.calls, ["confirmation", "references", "unlink"]);
  assert.deepEqual(h.deleted, [relative]);
});
test("reordering and inclusion do not delete any previously linked file", async () => {
  for (const next of [[{ id: "kept", position: 1 }, { id: "old", position: 2 }], [...final, { id: "old", position: 2 }, { id: "new", position: 3 }]]) {
    const h = harness(); await h.run([old, kept], next);
    assert.deepEqual(h.calls, []); assert.deepEqual(h.deleted, []);
  }
});
test("a surviving reference on any product including this product blocks deletion", async () => {
  const h = harness({ shared: true }); await h.run();
  assert.deepEqual(h.calls, ["confirmation", "references"]); assert.deepEqual(h.deleted, []);
});
test("unconfirmed or failed database save never reaches physical deletion", async () => {
  for (const options of [{ confirmation: false }, { queryFailure: true }]) {
    const h = harness(options); await assert.rejects(h.run());
    assert.deepEqual(h.calls, ["confirmation"]); assert.deepEqual(h.deleted, []);
  }
});
test("external, Cloudinary and unproven legacy paths are preserved", async () => {
  for (const url of ["https://external.test/a.jpg", "https://res.cloudinary.com/main/a.jpg", VPS_IMAGE_ORIGIN + "SKU/01-photo.jpg", old.url + "?v=1", old.url.replace("https:", "http:")]) {
    const h = harness(); await h.run([{ ...old, url }, kept]);
    assert.deepEqual(h.deleted, []); assert.deepEqual(h.calls, ["confirmation"]);
  }
});
test("ownership binds path to product editor or its original Drive source without renaming", () => {
  assert.equal(ownedImagePath(old.url, "p1"), relative);
  assert.equal(ownedImagePath(old.url, "p2"), null);
  const key = "drive-source", hash = photoDigest(Buffer.from(key));
  const path = `produtos/${hash.slice(0, 2)}/${hash}/1-${"a".repeat(64)}.jpg`;
  assert.equal(ownedImagePath(VPS_IMAGE_ORIGIN + path, "p1", key), path);
  assert.equal(ownedImagePath(VPS_IMAGE_ORIGIN + path, "p1"), null);
  assert.equal(ownedImagePath(VPS_IMAGE_ORIGIN + relative.replace("produtos/", "produtos/../"), "p1"), null);
});
test("unlink failure is recorded and reported as incomplete cleanup", async () => {
  const previous = console.error, logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const h = harness({ deletionFailure: true });
    await assert.rejects(h.run(), /fotos foram salvas.*limpeza.*SFTP denied/);
    assert.equal(logs.length, 1); assert.deepEqual(h.deleted, []);
  } finally { console.error = previous; }
});
