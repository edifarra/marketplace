/** Only the current ID authorizes Tiny operations. Send markers and results are history. */
export function activeTinyProductId(product: { tiny_product_id?: string | null }): string {
  return String(product.tiny_product_id || "").trim();
}
