"use server";

import { deleteProductById, inspectProductDeletion } from "@/lib/products";
import { removeProductIntegration, sendProductToConfiguredTarget } from "@/lib/product-sender";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { syncListingsStock } from "@/lib/inventory";
import { updateTinyProductPriceById } from "@/lib/tiny";
import { createTinyProduct, deactivateTinyProductById, updateTinyProduct } from "@/lib/tiny";
import { deleteCloudinaryResource, uploadProductImageToCloudinary } from "@/lib/cloudinary";

export async function deleteProductAction(formData: FormData) {
  await deleteProductById(formData);
}

export async function inspectProductDeletionAction(productId: string, manualTinyConfirmation = false) {
  return inspectProductDeletion(productId, manualTinyConfirmation);
}

export async function sendProductAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof sendProductToConfiguredTarget>>;
  try {
    result = await sendProductToConfiguredTarget(productId);
  } catch (error) {
    redirect(`/produtos?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/");
  revalidatePath("/produtos");

  const param = result.ok ? "sucesso" : "erro";
  redirect(`/produtos?${param}=${encodeURIComponent(result.message)}`);
}

export async function sendProductDetailAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof sendProductToConfiguredTarget>>;
  try {
    result = await sendProductToConfiguredTarget(productId);
  } catch (error) {
    redirect(`/produtos/${productId}?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${productId}`);

  const param = result.ok ? "sucesso" : "erro";
  redirect(`/produtos/${productId}?${param}=${encodeURIComponent(result.message)}`);
}

export async function removeProductIntegrationAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const integration = String(formData.get("integration") || "");
  const deleteExternal = String(formData.get("deleteExternal") || "") === "true";
  const externalId = String(formData.get("externalId") || "");
  const accountId = String(formData.get("accountId") || "");

  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof removeProductIntegration>>;
  try {
    result = await removeProductIntegration(productId, integration, deleteExternal, externalId, accountId);
  } catch (error) {
    redirect(`/produtos/${productId}?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${productId}`);

  const param = result.ok ? "sucesso" : "erro";
  redirect(`/produtos/${productId}?${param}=${encodeURIComponent(result.message)}`);
}

export async function updateProductInlineAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const title = String(formData.get("title") || "").trim();
  const price = Number(String(formData.get("price") || "0").replace(",", "."));
  const stock = Math.max(0, Math.trunc(Number(formData.get("stock") || 0)));
  if (!productId || !title || !Number.isFinite(price) || price < 0) redirect(`/produtos?erro=${encodeURIComponent("Dados do produto invalidos.")}`);
  const db = supabaseAdmin();
  const product = await db.from("products").select("id,sku,title,status,sent_target,tiny_product_id,listings(external_listing_id)").eq("id", productId).single().throwOnError();
  const awaitingPrice = ["pending_price", "manual_price"].includes(product.data.status);
  if (awaitingPrice && price <= 0) redirect(`/produtos?erro=${encodeURIComponent("Informe um preço maior que zero para liberar o produto para envio.")}`);
  const linked = Boolean(product.data.sent_target || product.data.tiny_product_id || product.data.listings?.some(item => item.external_listing_id));
  await db.from("products").update({ price, ...(awaitingPrice ? { status: "draft", price_evaluation_status: "MANUAL", price_evaluated_at: new Date().toISOString(), price_evaluation_error: null } : {}), ...(linked ? {} : { title }), updated_at: new Date().toISOString() }).eq("id", productId).throwOnError();
  await db.from("estoque").upsert({ product_id: productId, sku: product.data.sku }, { onConflict: "product_id" }).throwOnError();
  const adjusted = await db.rpc("set_physical_inventory", { p_product_id: productId, p_quantity: stock }).throwOnError();
  const availableStock = Number(adjusted.data ?? stock);
  await syncListingsStock(productId, availableStock);
  if (product.data.tiny_product_id) {
    try {
      await updateTinyProductPriceById(String(product.data.tiny_product_id), price);
    } catch (error) {
      revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
      redirect(`/produtos?erro=${encodeURIComponent(`Preco e estoque foram salvos no sistema, mas o Tiny recusou parte da sincronizacao: ${error instanceof Error ? error.message : String(error)}`)}`);
    }
  }
  revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
  redirect(`/produtos?sucesso=${encodeURIComponent("Produto atualizado com sucesso.")}`);
}

export async function updateProductDetailsAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const text = (key: string) => String(formData.get(key) || "").trim();
  const number = (key: string) => Number(text(key).replace(",", "."));
  const sku = text("sku"); const title = text("title"); const description = text("description");
  const redirectTo = text("redirectTo");
  const typeCode = text("typeCode"); const brandCode = text("brandCode"); const specialCode = text("specialCode") || null;
  const measures = { height: number("height"), width: number("width"), length: number("length"), weight_net: number("weightNet"), weight_gross: number("weightGross") };
  if (!productId || !sku || !title || !description || !typeCode || !brandCode || Object.values(measures).some(value => !Number.isFinite(value) || value < 0)) {
    redirect(`/produtos/${productId}?editar=1&erro=${encodeURIComponent("Preencha todos os campos com valores válidos.")}`);
  }
  const db = supabaseAdmin();
  const current = await db.from("products").select("*,product_images(id,original_name,cloudinary_public_id,position)").eq("id", productId).single().throwOnError();
  const keptIds = text("imageOrder").split(",").filter(Boolean);
  const existingImages = (current.data.product_images || []) as Array<{ id: string; original_name: string; cloudinary_public_id?: string | null; position: number }>;
  const removed = existingImages.filter(image => !keptIds.includes(image.id));

  try {
    await db.from("products").update({ sku, title, description, type_code: typeCode, brand_code: brandCode, special_code: specialCode, ...measures, updated_at: new Date().toISOString() }).eq("id", productId).throwOnError();
    await db.from("listings").update({ external_sku: sku }).eq("product_id", productId).throwOnError();
    await db.from("product_marketplaces").update({ sku, updated_at: new Date().toISOString() }).eq("product_id", productId).throwOnError();
    await db.from("estoque").update({ sku }).eq("product_id", productId).throwOnError();

    for (const image of existingImages) await db.from("product_images").update({ position: 1000 + image.position }).eq("id", image.id).throwOnError();
    for (const [index, id] of keptIds.entries()) await db.from("product_images").update({ position: index + 1 }).eq("id", id).eq("product_id", productId).throwOnError();
    for (const image of removed) {
      await db.from("product_images").delete().eq("id", image.id).throwOnError();
      await deleteCloudinaryResource(image.cloudinary_public_id);
    }

    let position = keptIds.length + 1;
    for (const entry of formData.getAll("newImages")) {
      if (!(entry instanceof File) || entry.size === 0) continue;
      if (!entry.type.startsWith("image/") || entry.size > 8 * 1024 * 1024) throw new Error(`A imagem ${entry.name} deve ser JPG, PNG ou WebP e ter no máximo 8 MB.`);
      const upload = await uploadProductImageToCloudinary({ buffer: Buffer.from(await entry.arrayBuffer()), fileName: entry.name, sku, typeCode, brandCode, model: String(current.data.model || "PRODUTO"), boardCode: String(current.data.board_code || ""), position });
      await db.from("product_images").insert({ product_id: productId, original_name: entry.name, url: upload.cloudinaryUrl, cloudinary_url: upload.cloudinaryUrl, cloudinary_public_id: upload.publicId, bytes: upload.bytes, position, status: "uploaded" }).throwOnError();
      position += 1;
    }

    if (current.data.tiny_product_id) {
      try {
        await updateTinyProduct(productId, String(current.data.tiny_product_id));
      } catch (updateError) {
        await deactivateTinyProductById(String(current.data.tiny_product_id));
        const recreated = await createTinyProduct(productId);
        await db.from("products").update({ tiny_product_id: recreated.idProduto, sent_target: "TINY", status: "sent", sent_at: new Date().toISOString() }).eq("id", productId).throwOnError();
      }
    }
  } catch (error) {
    revalidatePath(`/produtos/${productId}`);
    redirect(`/produtos/${productId}?editar=1&erro=${encodeURIComponent(`Os dados foram processados, mas a atualização não foi concluída: ${error instanceof Error ? error.message : String(error)}`)}`);
  }
  revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
  redirect(redirectTo.startsWith("/") && !redirectTo.startsWith("//")
    ? redirectTo
    : `/produtos/${productId}?sucesso=${encodeURIComponent("Produto salvo e integrações atualizadas com sucesso.")}`);
}
