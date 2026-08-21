"use server";

import {
  deleteSystemProductOnly,
  importMarketplaceSku,
  linkMarketplaceSkuToProduct,
  removeMarketplaceListingsForSku,
  sendSystemProductToMissingMarketplaces,
  updateDivergentStockByLowest
} from "@/lib/migration-stock";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { synchronizeProductBySku } from "@/lib/product-point-sync";

export async function importMarketplaceSkuAction(formData: FormData) {
  await runStockAction(formData, "marketplace-only", importMarketplaceSku);
}

export async function sendMissingMarketplacesAction(formData: FormData) {
  await runStockAction(formData, "missing-marketplace", sendSystemProductToMissingMarketplaces);
}

export async function deleteSystemProductOnlyAction(formData: FormData) {
  await runStockAction(formData, "system-only", deleteSystemProductOnly);
}

export async function removeMarketplaceListingsAction(formData: FormData) {
  await runStockAction(formData, "missing-marketplace", removeMarketplaceListingsForSku);
}

export async function removeMarketplaceOnlyListingsAction(formData: FormData) {
  await runStockAction(formData, "marketplace-only", removeMarketplaceListingsForSku);
}

export async function updateDivergentStockAction(formData: FormData) {
  await runStockAction(formData, "stock-divergent", updateDivergentStockByLowest);
}

export async function synchronizeStockSkuAction(formData: FormData) {
  const sku = String(formData.get("sku") || "").trim();
  const view = String(formData.get("view") || "system-only");
  if (!sku) redirect(`/estoque?view=${encodeURIComponent(view)}&erro=${encodeURIComponent("SKU nao informado.")}`);
  let result: Awaited<ReturnType<typeof synchronizeProductBySku>>;
  try {
    result = await synchronizeProductBySku(sku);
  } catch (error) {
    redirect(`/estoque?view=${encodeURIComponent(view)}&erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
  revalidatePath("/");
  revalidatePath("/estoque");
  revalidatePath("/produtos");
  revalidatePath("/logs");
  const message = result.errors.length
    ? `Sincronismo do SKU ${result.sku} concluido com ${result.errors.length} alerta(s). Consulte o Log.`
    : `SKU ${result.sku} sincronizado. ${result.listings.length} anuncio(s) encontrado(s).`;
  redirect(`/estoque?view=${encodeURIComponent(view)}&sucesso=${encodeURIComponent(message)}`);
}

export async function linkMarketplaceSkuAction(formData: FormData) {
  const sourceSku = String(formData.get("sku") || "").trim();
  const targetSku = String(formData.get("targetSku") || "").trim();
  const status = String(formData.get("status") || "all");
  const stock = String(formData.get("stock") || "all");
  if (!sourceSku || !targetSku) {
    redirect(`/estoque?view=marketplace-only&status=${encodeURIComponent(status)}&stock=${encodeURIComponent(stock)}&erro=${encodeURIComponent("Informe o SKU do produto para vincular.")}`);
  }
  try {
    await linkMarketplaceSkuToProduct(sourceSku, targetSku);
  } catch (error) {
    redirect(`/estoque?view=marketplace-only&status=${encodeURIComponent(status)}&stock=${encodeURIComponent(stock)}&erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
  revalidatePath("/estoque");
  revalidatePath("/produtos");
  redirect(`/estoque?view=marketplace-only&status=${encodeURIComponent(status)}&stock=${encodeURIComponent(stock)}&sucesso=${encodeURIComponent(`Anuncio ${sourceSku} vinculado ao produto ${targetSku}.`)}`);
}

async function runStockAction(
  formData: FormData,
  view: string,
  action: (sku: string) => Promise<void>
) {
  const sku = String(formData.get("sku") || "").trim();
  if (!sku) {
    redirect(`/estoque?view=${view}&erro=${encodeURIComponent("SKU nao informado.")}`);
  }

  try {
    await action(sku);
  } catch (error) {
    redirect(`/estoque?view=${view}&erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/estoque");
  revalidatePath("/produtos");
  redirect(`/estoque?view=${view}&sucesso=${encodeURIComponent("Acao executada com sucesso.")}`);
}
