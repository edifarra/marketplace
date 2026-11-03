import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProductImageSource } from "./product-image-source";
import { VPS_IMAGE_ORIGIN, type StoredDrivePhoto } from "./drive-photo-processing";

export function isProtectedLegacyPhoto(image: ProductImageSource & { cloudinary_public_id?: string | null; cloudinary_cloud_name?: string | null }) {
  return image.cloudinary_cloud_name === "dknfrkqol"
    || /^dknfrkqol[:/]/.test(image.cloudinary_public_id || "")
    || [image.url, image.local_url, image.cloudinary_url].some(value => {
      try { const url = new URL(value || ""); return url.hostname === "res.cloudinary.com" && url.pathname.split("/")[1] === "dknfrkqol"; }
      catch { return false; }
    });
}

export function validatePhotoSequence(sequence: string[], images: Array<ProductImageSource & { id: string; position: number }>) {
  if (!sequence.length || sequence.length > 6 || new Set(sequence).size !== sequence.length) throw new Error("Selecione entre 1 e 6 fotos, sem repetições.");
  if (sequence.some(token => !/^(existing|new|remote):.+$/.test(token))) throw new Error("Sequência de fotos inválida.");
  const ids = new Set(images.map(image => image.id));
  if (sequence.some(token => token.startsWith("existing:") && !ids.has(token.slice(9)))) throw new Error("Uma foto não pertence mais ao produto. Reabra a edição.");
  if (images.some(isProtectedLegacyPhoto)) {
    const original = [...images].sort((a, b) => a.position - b.position).map(image => "existing:" + image.id);
    if (sequence.length !== original.length || sequence.some((token, index) => token !== original[index])) throw new Error("As fotografias deste produto estão preservadas por conter vínculos da conta desativada.");
  }
  for (const image of images.filter(isProtectedLegacyPhoto)) {
    if (sequence[image.position - 1] !== `existing:${image.id}`) throw new Error("Os vínculos da conta Cloudinary desativada devem permanecer nas posições originais.");
  }
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
