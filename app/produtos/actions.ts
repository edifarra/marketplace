"use server";

import { deleteProductById } from "@/lib/products";
import { removeProductIntegration, sendProductToConfiguredTarget } from "@/lib/product-sender";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { syncListingsStock } from "@/lib/inventory";
import { updateTinyProductPriceById, updateTinyProductStockById } from "@/lib/tiny";

export async function deleteProductAction(formData: FormData) {
  await deleteProductById(formData);
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
  const product = await db.from("products").select("id,sku,title,sent_target,tiny_product_id,listings(external_listing_id)").eq("id", productId).single().throwOnError();
  const linked = Boolean(product.data.sent_target || product.data.tiny_product_id || product.data.listings?.some(item => item.external_listing_id));
  await db.from("products").update({ price, ...(linked ? {} : { title }), updated_at: new Date().toISOString() }).eq("id", productId).throwOnError();
  await db.from("estoque").upsert({ product_id: productId, sku: product.data.sku, estoque_fisico: stock }, { onConflict: "product_id" }).throwOnError();
  await syncListingsStock(productId, stock);
  if (product.data.tiny_product_id) {
    try {
      await updateTinyProductPriceById(String(product.data.tiny_product_id), price);
      await updateTinyProductStockById(String(product.data.tiny_product_id), stock);
    } catch (error) {
      revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
      redirect(`/produtos?erro=${encodeURIComponent(`Preco e estoque foram salvos no sistema, mas o Tiny recusou parte da sincronizacao: ${error instanceof Error ? error.message : String(error)}`)}`);
    }
  }
  revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
  redirect(`/produtos?sucesso=${encodeURIComponent("Produto atualizado com sucesso.")}`);
}
