import { uploadProductImageToCloudinary } from "./cloudinary";
import { supabaseAdmin } from "./supabase-admin";

const MAX_IMAGES = 6;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export async function recoverProductImagesFromMarketplaceListing(
  productId: string,
  rawData: Record<string, unknown>
) {
  const imageUrls = extractMarketplaceImageUrls(rawData).slice(0, MAX_IMAGES);
  if (!imageUrls.length) return 0;

  const db = supabaseAdmin();
  const [productResult, existingResult] = await Promise.all([
    db.from("products").select("sku,type_code,brand_code,model,board_code").eq("id", productId).single().throwOnError(),
    db.from("product_images").select("id", { count: "exact", head: true }).eq("product_id", productId)
  ]);
  if (existingResult.error) throw existingResult.error;
  if ((existingResult.count || 0) > 0) return 0;

  const product = productResult.data;
  let recovered = 0;
  for (const [index, url] of imageUrls.entries()) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Falha ao baixar a foto do anuncio (${response.status}).`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_SOURCE_BYTES) throw new Error("A foto do anuncio excede 8 MB.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error("A foto do anuncio excede 8 MB.");
    const position = index + 1;
    const upload = await uploadProductImageToCloudinary({
      buffer,
      fileName: marketplaceFileName(url, position),
      sku: String(product.sku || ""),
      typeCode: String(product.type_code || ""),
      brandCode: String(product.brand_code || ""),
      model: String(product.model || "PRODUTO"),
      boardCode: String(product.board_code || ""),
      position
    });
    await db.from("product_images").insert({
      product_id: productId,
      original_name: marketplaceFileName(url, position),
      url: upload.cloudinaryUrl,
      cloudinary_url: upload.cloudinaryUrl,
      cloudinary_public_id: upload.publicId,
      bytes: upload.bytes,
      position,
      status: "uploaded"
    }).throwOnError();
    recovered += 1;
  }
  return recovered;
}

export function extractMarketplaceImageUrls(rawData: Record<string, unknown>) {
  const image = asRecord(rawData.image);
  const imageInfo = asRecord(rawData.image_info);
  const pictures = Array.isArray(rawData.pictures) ? rawData.pictures : [];
  const candidates = [
    ...pictures.flatMap((picture) => {
      const value = asRecord(picture);
      return [value.secure_url || value.url];
    }),
    ...asArray(image.image_url_list),
    ...asArray(imageInfo.image_url_list),
    image.image_url,
    imageInfo.image_url
  ];
  return [...new Set(candidates.map((value) => normalizeImageUrl(String(value || "").trim())).filter(isHttpUrl))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown) { return Array.isArray(value) ? value : []; }
function isHttpUrl(value: string) { return /^https?:\/\//i.test(value); }
function normalizeImageUrl(value: string) { return value.replace(/^http:\/\//i, "https://"); }
function marketplaceFileName(url: string, position: number) {
  const extension = new URL(url).pathname.match(/\.(jpe?g|png|webp)$/i)?.[1]?.toLowerCase() || "jpg";
  return `marketplace-${String(position).padStart(2, "0")}.${extension}`;
}
