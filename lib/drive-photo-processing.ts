import { createHash } from "node:crypto";
import sharp from "sharp";

export const MAX_DRIVE_PHOTO_BYTES = 25 * 1024 * 1024;
export const VPS_IMAGE_ORIGIN = "https://api.gestaomarketplace.tech/Imagens/";

export type StoredDrivePhoto = {
  url: string;
  localPath: string;
  bytes: number;
  width: number;
  height: number;
};

export function photoDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function processDrivePhoto(input: Buffer) {
  if (!input.length || input.length > MAX_DRIVE_PHOTO_BYTES) throw new Error("Fotografia vazia ou maior que 25 MB.");
  const image = sharp(input, { failOn: "warning", limitInputPixels: 40_000_000, animated: false });
  const metadata = await image.metadata();
  if (!metadata.format || !["jpeg", "png", "webp", "heif", "tiff", "avif"].includes(metadata.format)
    || (metadata.pages || 1) > 1) throw new Error("Formato de fotografia não suportado ou imagem com múltiplas páginas.");
  const { data, info } = await image.rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 45 }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bytes: data.length };
}

export async function processAndStoreDrivePhoto(input: { buffer: Buffer; sourceKey: string; position: number },
  store: (relativePath: string, bytes: Buffer) => Promise<void>): Promise<StoredDrivePhoto> {
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > 6) throw new Error("Posição inválida.");
  const image = await processDrivePhoto(input.buffer);
  // Content-addressed immutable names make retries and concurrent requests safe.
  const source = photoDigest(Buffer.from(input.sourceKey));
  const relativePath = `produtos/${source.slice(0, 2)}/${source}/${input.position}-${photoDigest(image.data)}.jpg`;
  await store(relativePath, image.data);
  return { url: VPS_IMAGE_ORIGIN + relativePath, localPath: relativePath,
    bytes: image.bytes, width: image.width, height: image.height };
}

export function drivePhotoRows(images: Array<{ driveFile: { id: string; name: string }; upload: StoredDrivePhoto; position: number }>) {
  if (!images.length || images.length > 6 || images.some((image, index) => image.position !== index + 1)) {
    throw new Error("Fotografias devem estar em posições contíguas de 1 a 6.");
  }
  return images.map(({ driveFile, upload, position }) => ({
    drive_file_id: driveFile.id, original_name: driveFile.name,
    url: upload.url, local_url: upload.url, local_path: upload.localPath,
    bytes: upload.bytes, width_px: upload.width, height_px: upload.height,
    position, status: "uploaded"
  }));
}
