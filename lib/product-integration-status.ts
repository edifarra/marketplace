import { supabaseAdmin } from "./supabase-admin";

export async function clearTinyLink(productId: string) {
  await supabaseAdmin().from("products").update({
    tiny_product_id: null,
    sent_target: null,
    sent_at: null,
    tiny_last_synced_on: null,
    updated_at: new Date().toISOString()
  }).eq("id", productId).throwOnError();
  await supabaseAdmin().from("settings").delete().eq("key", `TINY_LAST_PRODUCT_${productId}`);
}

export async function reconcileProductIntegrationStatus(productId: string) {
  const db = supabaseAdmin();
  const [product, marketplaceLinks, listings] = await Promise.all([
    db.from("products").select("tiny_product_id").eq("id", productId).maybeSingle().throwOnError(),
    db.from("product_marketplaces").select("id", { count: "exact", head: true })
      .eq("product_id", productId).eq("existe_no_marketplace", true).throwOnError(),
    db.from("listings").select("id", { count: "exact", head: true })
      .eq("product_id", productId).not("external_listing_id", "is", null).throwOnError()
  ]);
  const hasAnyLink = Boolean(product.data?.tiny_product_id)
    || Number(marketplaceLinks.count || 0) > 0
    || Number(listings.count || 0) > 0;
  if (!hasAnyLink) {
    await db.from("products").update({
      status: "draft", sent_target: null, sent_at: null, tiny_product_id: null,
      updated_at: new Date().toISOString()
    }).eq("id", productId).throwOnError();
  }
  return hasAnyLink;
}

export function isTinyNotFoundError(error: unknown) {
  return /produto\s+(?:n[aã]o\s+localizado|n[aã]o\s+encontrado)|not\s+found/i.test(error instanceof Error ? error.message : String(error));
}
