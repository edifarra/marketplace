import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { processDrivePhoto, processAndStoreDrivePhoto, drivePhotoRows, photoDigest, MAX_DRIVE_PHOTO_BYTES } from "../lib/drive-photo-processing";
import { persistDriveProduct } from "../lib/drive-product-persistence";
import { readBoundedImage } from "../lib/bounded-image-download";
import { storeImmutablePhoto, vpsImageConfig, type ImageTransfer } from "../lib/vps-image-storage";
import { coverTransformationId, prepareProductMarketplaceImages } from "../lib/product-marketplace-images";

const fixture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#bd3824" } }).png().toBuffer();

test("Sharp JPEG quality 45: maximum 1200, aspect ratio, no enlargement, correct EXIF orientation", async () => {
  for (const [width, height, expected] of [[2400, 1200, [1200, 600]], [100, 200, [100, 200]], [1200, 2400, [600, 1200]]] as const) {
    const input = await fixture(width, height);
    const output = await processDrivePhoto(input);
    const expectedBytes = await sharp(input, { failOn: "warning", limitInputPixels: 40_000_000 }).rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 45 }).toBuffer();
    assert.deepEqual(output.data, expectedBytes);
    assert.deepEqual([output.width, output.height], expected);
    assert.equal(output.bytes, output.data.length);
    assert.equal((await sharp(output.data).metadata()).format, "jpeg");
  }
  const oriented = await sharp(await fixture(300, 100)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const output = await processDrivePhoto(oriented);
  assert.deepEqual([output.width, output.height], [100, 300]);
  assert.equal((await sharp(output.data).metadata()).orientation, undefined);
});

test("invalid, oversized and animated files fail before storage", async () => {
  for (const buffer of [Buffer.alloc(0), Buffer.from("invalid"), Buffer.alloc(MAX_DRIVE_PHOTO_BYTES + 1), Buffer.from('<svg width="1" height="1"></svg>')]) {
    let stored = false;
    await assert.rejects(processAndStoreDrivePhoto({ buffer, sourceKey: "test", position: 1 }, async () => { stored = true; }));
    assert.equal(stored, false);
  }
  await assert.rejects(processDrivePhoto(await sharp({ create: { width: 10, height: 20, channels: 3, background: "red", pageHeight: 10 } }).gif().toBuffer()));
});

function transport() {
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const transfer: ImageTransfer = {
    mkdir: async () => {}, read: async file => files.get(file) || null,
    writeExclusive: async (file, bytes) => { assert.ok(!files.has(file)); files.set(file, bytes); },
    rename: async (from, to) => { if (files.has(to)) throw new Error("exists"); files.set(to, files.get(from)!); files.delete(from); },
    unlink: async file => { removed.push(file); files.delete(file); }
  };
  return { files, removed, transfer };
}

test("content names are unique, stable on retry and preserve positions with real metadata", async () => {
  const h = transport();
  const store = (file: string, bytes: Buffer) => storeImmutablePhoto(h.transfer, "/images", file, bytes);
  const buffer = await fixture(300, 100);
  const first = await processAndStoreDrivePhoto({ buffer, sourceKey: "../../SKU", position: 1 }, store);
  const retry = await processAndStoreDrivePhoto({ buffer, sourceKey: "../../SKU", position: 1 }, store);
  assert.deepEqual(first, retry);
  assert.equal(h.files.size, 1);
  const second = await processAndStoreDrivePhoto({ buffer, sourceKey: "../../SKU", position: 2 }, store);
  assert.notEqual(second.url, first.url);
  const other = await processAndStoreDrivePhoto({ buffer, sourceKey: "other", position: 1 }, store);
  assert.notEqual(other.url, first.url);
  const rows = drivePhotoRows([first, second].map((upload, index) => ({ upload, position: index + 1, driveFile: { id: String(index), name: `${index}.png` } })));
  assert.deepEqual(rows.map(r => r.url), [first.url, second.url]);
  assert.deepEqual(rows.map(r => r.position), [1, 2]);
  assert.ok(rows.every(r => r.width_px === 300 && r.height_px === 100 && r.bytes === first.bytes && !('cloudinary_url' in r)));
  await persistDriveProduct({ product: { source_key: "test" }, images: rows, accounts: [] }, async args => {
    assert.deepEqual(args.p_images, rows);
    return { id: "id", sku: "sku", created: true };
  });
  await assert.rejects(persistDriveProduct({ product: {}, images: rows, accounts: [] }, async () => { throw new Error("database failure"); }), /database failure/);
  // Ambiguous DB failure must not delete immutable files.
  assert.equal(h.files.size, 3);
  assert.throws(() => drivePhotoRows([{ upload: first, position: 2, driveFile: { id: "1", name: "a" } }]), /posições/);
});

test("interrupted transfers clean only own temporary files, verify integrity and allow retry", async () => {
  const bytes = Buffer.from("jpeg");
  const name = `produtos/aa/${"a".repeat(64)}/1-${photoDigest(bytes)}.jpg`;
  for (const stage of ["write", "rename", "verify"]) {
    const h = transport();
    h.files.set("/unrelated", Buffer.from("keep"));
    if (stage === "write") h.transfer.writeExclusive = async (file, buffer) => { h.files.set(file, buffer); throw new Error("interrupted"); };
    if (stage === "rename") h.transfer.rename = async () => { throw new Error("interrupted"); };
    if (stage === "verify") h.transfer.writeExclusive = async file => { h.files.set(file, Buffer.from("corrupt")); };
    await assert.rejects(storeImmutablePhoto(h.transfer, "/images", name, bytes));
    assert.deepEqual([...h.files.keys()], ["/unrelated"]);
    assert.equal(h.removed.length, 1);
    assert.match(h.removed[0], /\.part$/);
  }
  const h = transport();
  await Promise.all([storeImmutablePhoto(h.transfer, "/images", name, bytes), storeImmutablePhoto(h.transfer, "/images", name, bytes)]);
  assert.deepEqual([...h.files.keys()], [`/images/${name}`]);
  h.files.set(`/images/${name}`, Buffer.from("corrupt"));
  await assert.rejects(storeImmutablePhoto(h.transfer, "/images", name, bytes), /Integridade/);
  await assert.rejects(storeImmutablePhoto(h.transfer, "/images", "../escape.jpg", bytes), /Caminho/);
});

test("downloads enforce byte limits even without content-length", async () => {
  assert.deepEqual(await readBoundedImage(new Response("abc"), 3), Buffer.from("abc"));
  await assert.rejects(readBoundedImage(new Response("abcd"), 3), /limite/);
  await assert.rejects(readBoundedImage(new Response("abc", { headers: { "content-length": "100" } }), 3), /limite/);
  await assert.rejects(readBoundedImage(new Response(null, { status: 404 }), 3), /404/);
});

test("SFTP requires server secrets and a pinned host key, fails closed", () => {
  assert.throws(() => vpsImageConfig({}), /não configurado/);
  const env = { VPS_IMAGES_SFTP_HOST: "host", VPS_IMAGES_SFTP_USER: "images", VPS_IMAGES_SFTP_KEY_BASE64: "a2V5",
    VPS_IMAGES_SFTP_ROOT: "/Imagens", VPS_IMAGES_SFTP_HOST_SHA256: "a".repeat(64) };
  assert.equal(vpsImageConfig(env).port, 22);
  assert.throws(() => vpsImageConfig({ ...env, VPS_IMAGES_SFTP_HOST_SHA256: "untrusted" }), /inválida/);
  assert.throws(() => vpsImageConfig({ ...env, VPS_IMAGES_SFTP_ROOT: "/" }), /inválida/);
});

test("publication prepares only cover 1; all five secondary VPS files retain exact URLs and order", async () => {
  const images = [1, 2, 3, 4, 5, 6].map(position => ({ position, url: `https://api.gestaomarketplace.tech/Imagens/test/${position}.jpg` }));
  const downloads: string[] = [];
  let transforms = 0, persists = 0;
  const bytes = new Uint8Array([1, 2, 3]);
  const result = await prepareProductMarketplaceImages([...images].reverse(), {
    available: async () => true,
    download: async url => { downloads.push(url); return bytes; },
    transform: async (_bytes, id) => { transforms++; return `https://res.cloudinary.com/test/image/upload/v1/${id}.jpg`; },
    persist: async image => { persists++; assert.equal(image.position, 1); }
  });
  assert.deepEqual(downloads, [images[0].url]);
  assert.equal(transforms, 1); assert.equal(persists, 1);
  assert.deepEqual(result.slice(1), images.slice(1).map(image => image.url));
  assert.ok(result[0].includes(coverTransformationId(images[0].url, bytes)));
});
