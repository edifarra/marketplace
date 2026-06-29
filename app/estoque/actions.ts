"use server";

import {
  deleteSystemProductOnly,
  importMarketplaceSku,
  removeMarketplaceListingsForSku,
  sendSystemProductToMissingMarketplaces,
  updateDivergentStockByLowest
} from "@/lib/migration-stock";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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
