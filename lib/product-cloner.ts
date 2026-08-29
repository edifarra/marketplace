import { deleteCloudinaryResource, uploadProductImageToCloudinary } from "./cloudinary";
import { nextSku } from "./pipeline";
import { supabaseAdmin } from "./supabase-admin";
import { TypeConfig } from "./types";

export type ClonedProduct = { id: string; sku: string; title: string };

export async function cloneProduct(productId: string): Promise<ClonedProduct> {
  const db = supabaseAdmin();
  const [sourceResult, imagesResult, listingsResult, inventoryResult] = await Promise.all([
    db.from("products").select("*").eq("id", productId).single().throwOnError(),
    db.from("product_images").select("*").eq("product_id", productId).order("position").throwOnError(),
    db.from("listings").select("*").eq("product_id", productId).throwOnError(),
    db.from("estoque").select("estoque_fisico").eq("product_id", productId).maybeSingle().throwOnError()
  ]);
  const source = sourceResult.data as Record<string, unknown>;
  const typeCode = String(source.type_code || "");
  if (!typeCode) throw new Error("O produto original nao possui tipo para gerar o novo SKU.");
  const typeResult = await db.from("config_types").select("*").eq("code", typeCode).single().throwOnError();
  const newSku = await reserveNextSku(typeResult.data as Record<string, unknown>, String(source.special_code || ""));
  const createdCloudinaryIds: string[] = [];
  let cloneId = "";

  try {
    const insert = await db.from("products").insert({
      sku: newSku,
      source_key: `clone_${productId}_${newSku}_${Date.now()}`,
      type_code: source.type_code,
      brand_code: source.brand_code,
      special_code: source.special_code,
      model: source.model,
      version: source.version,
      board_code: source.board_code,
      title: source.title,
      description: source.description,
      price: source.price,
      stock: source.stock,
      status: "draft",
      weight_net: source.weight_net,
      weight_gross: source.weight_gross,
      width: source.width,
      height: source.height,
      length: source.length,
      price_evaluation_status: source.price_evaluation_status,
      price_evaluation_result: source.price_evaluation_result,
      price_evaluated_at: source.price_evaluated_at,
      price_evaluation_error: source.price_evaluation_error
    }).select("id,sku,title").single().throwOnError();
    cloneId = String(insert.data.id);

    for (const image of imagesResult.data || []) {
      const sourceUrl = String(image.cloudinary_url || image.url || image.local_url || "");
      if (!sourceUrl) continue;
      const response = await fetch(sourceUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`Nao foi possivel copiar a foto ${image.original_name}: ${response.status}.`);
      const upload = await uploadProductImageToCloudinary({
        buffer: Buffer.from(await response.arrayBuffer()),
        fileName: String(image.original_name || `foto-${image.position}.jpg`),
        sku: newSku,
        typeCode,
        brandCode: String(source.brand_code || ""),
        model: String(source.model || "PRODUTO"),
        boardCode: String(source.board_code || ""),
        position: Number(image.position || 1)
      });
      createdCloudinaryIds.push(upload.publicId);
      await db.from("product_images").insert({
        product_id: cloneId,
        original_name: image.original_name,
        url: upload.cloudinaryUrl,
        cloudinary_url: upload.cloudinaryUrl,
        cloudinary_public_id: upload.publicId,
        cloudinary_cloud_name: upload.cloudName,
        bytes: upload.bytes,
        width_px: upload.width,
        height_px: upload.height,
        position: image.position,
        status: "uploaded"
      }).throwOnError();
    }

    const clonedListings = (listingsResult.data || []).map((listing) => ({
      product_id: cloneId,
      marketplace: listing.marketplace,
      marketplace_account_id: listing.marketplace_account_id,
      marketplace_name: listing.marketplace_name,
      external_sku: newSku,
      status: "draft",
      stock: listing.stock,
      price: listing.price
    }));
    if (clonedListings.length) await db.from("listings").insert(clonedListings).throwOnError();

    const physicalStock = Number(inventoryResult.data?.estoque_fisico ?? source.stock ?? 0);
    await db.from("estoque").upsert({ product_id: cloneId, sku: newSku }, { onConflict: "product_id" }).throwOnError();
    await db.rpc("set_physical_inventory", { p_product_id: cloneId, p_quantity: Math.max(0, Math.trunc(physicalStock)) }).throwOnError();
    return { id: cloneId, sku: newSku, title: String(source.title || "") };
  } catch (error) {
    if (cloneId) await db.from("products").delete().eq("id", cloneId);
    for (const publicId of createdCloudinaryIds) await deleteCloudinaryResource(publicId).catch(() => undefined);
    throw error;
  }
}

async function reserveNextSku(typeRow: Record<string, unknown>, specialCode: string) {
  const db = supabaseAdmin();
  const type = toTypeConfig(typeRow);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const counter = await db.from("sku_counters").select("current_number").eq("sku_group", type.skuGroup).maybeSingle().throwOnError();
    const currentNumber = Number(counter.data?.current_number ?? type.skuMax ?? 0);
    const generated = nextSku(type, currentNumber, specialCode);
    const update = counter.data
      ? await db.from("sku_counters").update({ current_number: generated.nextNumber, updated_at: new Date().toISOString() }).eq("sku_group", type.skuGroup).eq("current_number", currentNumber).select("sku_group")
      : await db.from("sku_counters").insert({ sku_group: type.skuGroup, current_number: generated.nextNumber }).select("sku_group");
    if (!update.error && update.data?.length) return generated.sku;
  }
  throw new Error("Nao foi possivel reservar o SKU do clone. Tente novamente.");
}

function toTypeConfig(row: Record<string, unknown>): TypeConfig {
  return {
    code: String(row.code || ""), description: String(row.description || ""), skuGroup: String(row.sku_group || ""),
    skuMax: row.sku_max == null ? undefined : Number(row.sku_max), titleTemplate: String(row.title_template || ""),
    descriptionTemplate: String(row.description_template || ""), warrantyMonths: Number(row.warranty_months || 0),
    dimensions: { weightNet: Number(row.weight_net || 0), weightGross: Number(row.weight_gross || 0), width: Number(row.width || 0), height: Number(row.height || 0), length: Number(row.length || 0) }
  };
}
