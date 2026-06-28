"use server";

import { createProductFromForm, CreateProductState } from "@/lib/products";

export async function createProductAction(
  _previousState: CreateProductState,
  formData: FormData
): Promise<CreateProductState> {
  try {
    return await createProductFromForm(formData);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "Nao foi possivel cadastrar o produto."
    };
  }
}

function isRedirectError(error: unknown) {
  return (
    error instanceof Error &&
    ("digest" in error ? String(error.digest).startsWith("NEXT_REDIRECT") : error.message === "NEXT_REDIRECT")
  );
}
