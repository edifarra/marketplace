import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProductImageSource } from "./product-image-source";
import { VPS_IMAGE_ORIGIN, type StoredDrivePhoto } from "./drive-photo-processing";
import { mergeRecoveredImages } from "./product-image-source";

type PhotoSnapshot = Array<{ id: string; position: number }>;
type RecoveryOrigin = { marketplace: string; accountId: string; listingId: string };
export function signRecoverySequence(productId: string, images: PhotoSnapshot, recovered: Array<{ key: string; position: number }>, origin: RecoveryOrigin, secret?: string) {
  const sequence = mergeRecoveredImages(images.map(image => ({ position: image.position, token: `existing:${image.id}` })),
    recovered.map(image => ({ position: image.position, token: `remote:${image.key}` }))).map(image => image.token);
  const source = { marketplace: origin.marketplace, accountId: origin.accountId, listingId: origin.listingId };
  const payload = Buffer.from(JSON.stringify({ kind: "recovery-sequence", productId, images: images.map(({ id, position }) => ({ id, position })), sequence, origin: source, expiresAt: Date.now() + 86400000 })).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

// An absent receipt keeps old open editors conservative: they still synchronize.
export function recoverySequenceChanged(receipt: string, productId: string, images: PhotoSnapshot, sequence: string[], origin: RecoveryOrigin, secret?: string) {
  if (!receipt) return true;
  try {
    if (receipt.length > 8192) throw Error();
    const [payload, mac, extra] = receipt.split(".");
    const actual = Buffer.from(mac || "", "base64url"), expected = signature(payload, secret);
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
    const snapshot = JSON.parse(Buffer.from(payload, "base64url").toString());
    const canonical = (rows: PhotoSnapshot) => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => [row.id, row.position]));
    if (snapshot.kind !== "recovery-sequence" || snapshot.productId !== productId || snapshot.expiresAt < Date.now()
      || canonical(snapshot.images) !== canonical(images) || JSON.stringify(snapshot.origin) !== JSON.stringify(origin)) throw Error();
    return JSON.stringify(snapshot.sequence) !== JSON.stringify(sequence);
  } catch { throw new Error("A recuperação de fotos expirou ou o produto mudou. Reabra a edição."); }
}

export function validatePhotoSequence(sequence: string[], images: Array<ProductImageSource & { id: string; position: number }>) {
  if (!sequence.length || sequence.length > 6 || new Set(sequence).size !== sequence.length) throw new Error("Selecione entre 1 e 6 fotos, sem repetições.");
  if (sequence.some(token => !/^(existing|new|remote):.+$/.test(token))) throw new Error("Sequência de fotos inválida.");
  const ids = new Set(images.map(image => image.id));
  if (sequence.some(token => token.startsWith("existing:") && !ids.has(token.slice(9)))) throw new Error("Uma foto não pertence mais ao produto. Reabra a edição.");
}

export type PreparedProductPhoto = StoredDrivePhoto & { name: string; productId: string; userId: string; expiresAt: number };
function signature(payload: string, secret = process.env.AUTH_SESSION_SECRET) {
  if (!secret) throw new Error("Assinatura de fotografias não configurada.");
  return createHmac("sha256", secret).update("product-photo-v1\0" + payload).digest();
}
export function signPreparedPhoto(photo: PreparedProductPhoto, secret?: string) {
  const payload = Buffer.from(JSON.stringify(photo)).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}
export function verifyPreparedPhoto(receipt: string, productId: string, userId: string, secret?: string): PreparedProductPhoto {
  if (typeof receipt !== "string" || receipt.length > 8192) throw new Error("Comprovante da foto inválido.");
  const parts = receipt.split(".");
  const expected = signature(parts[0], secret), actual = Buffer.from(parts[1] || "", "base64url");
  if (parts.length !== 2 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Comprovante da foto inválido.");
  const photo = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as PreparedProductPhoto;
  if (photo.productId !== productId || photo.userId !== userId || photo.expiresAt < Date.now()
    || !/^produtos\/[a-f0-9]{2}\/[a-f0-9]{64}\/[1-6]-[a-f0-9]{64}\.jpg$/.test(photo.localPath)
    || photo.url !== VPS_IMAGE_ORIGIN + photo.localPath) throw new Error("Foto expirada ou pertencente a outra edição. Envie novamente.");
  return photo;
}
