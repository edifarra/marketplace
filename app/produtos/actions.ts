"use server";

import { deleteProductById } from "@/lib/products";
import { removeProductIntegration, sendProductToConfiguredTarget } from "@/lib/product-sender";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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

  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof removeProductIntegration>>;
  try {
    result = await removeProductIntegration(productId, integration, deleteExternal);
  } catch (error) {
    redirect(`/produtos/${productId}?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${productId}`);

  const param = result.ok ? "sucesso" : "erro";
  redirect(`/produtos/${productId}?${param}=${encodeURIComponent(result.message)}`);
}
