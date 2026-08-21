import { supabaseAdmin } from "./supabase-admin";

export type ModerationClassification = "final" | "review";

export type MarketplaceModerationInput = {
  marketplace: "mercado_livre" | "shopee";
  accountId: string;
  storeName: string;
  listingId: string;
  sku?: string | null;
  productName?: string | null;
  status: string;
  classification: ModerationClassification;
  reason?: string | null;
  remedy?: string | null;
  sourceEventId?: string | null;
  eventAt?: string | null;
  rawData?: Record<string, unknown>;
};

export async function recordMarketplaceModeration(input: MarketplaceModerationInput) {
  const db = supabaseAdmin();
  const existing = await db.from("product_marketplaces")
    .select("sku,titulo_marketplace,product_id,raw_data")
    .eq("marketplace_account_id", input.accountId)
    .eq("marketplace_product_id", input.listingId)
    .maybeSingle().throwOnError();
  const link = existing.data as Record<string, any> | null;
  const sku = String(input.sku || link?.sku || "");
  const productName = String(input.productName || link?.titulo_marketplace || input.listingId);
  const rawData = { ...(link?.raw_data || {}), ...(input.rawData || {}), moderation_reason: input.reason || null, moderation_remedy: input.remedy || null };

  await db.from("marketplace_listing_moderations").upsert({
    marketplace: input.marketplace,
    marketplace_account_id: input.accountId,
    store_name: input.storeName,
    sku: sku || null,
    product_name: productName,
    listing_id: input.listingId,
    status: input.status,
    classification: input.classification,
    reason: input.reason || null,
    remedy: input.remedy || null,
    source_event_id: input.sourceEventId || null,
    raw_data: input.rawData || {},
    event_at: input.eventAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "marketplace,marketplace_account_id,listing_id" }).throwOnError();

  if (link) {
    await db.from("product_marketplaces").update(input.classification === "final" ? {
      product_id: null,
      existe_no_marketplace: false,
      status_anuncio: input.status,
      raw_data: rawData,
      updated_at: new Date().toISOString()
    } : {
      status_anuncio: input.status,
      raw_data: rawData,
      updated_at: new Date().toISOString()
    }).eq("marketplace_account_id", input.accountId).eq("marketplace_product_id", input.listingId).throwOnError();
  }

  if (input.classification === "final") {
    await db.from("listings").delete()
      .eq("marketplace_account_id", input.accountId)
      .eq("external_listing_id", input.listingId).throwOnError();
  } else {
    await db.from("listings").update({
      status: "paused", error_message: input.reason || input.remedy || null, last_sync_at: new Date().toISOString()
    }).eq("marketplace_account_id", input.accountId).eq("external_listing_id", input.listingId).throwOnError();
  }
}

export async function clearMarketplaceModeration(marketplace: string, accountId: string, listingId: string) {
  await supabaseAdmin().from("marketplace_listing_moderations").delete()
    .eq("marketplace", marketplace).eq("marketplace_account_id", accountId).eq("listing_id", listingId).throwOnError();
}

export function mercadoLivreModerationClass(status: string, subStatus: unknown): ModerationClassification | null {
  const normalized = String(status || "").toLowerCase();
  const subs = (Array.isArray(subStatus) ? subStatus : []).map(value => String(value).toLowerCase());
  if (["closed", "inactive"].includes(normalized) || subs.includes("forbidden")) return "final";
  if (normalized === "under_review") return "review";
  return null;
}

export function shopeeModerationClass(status: string): ModerationClassification | null {
  const normalized = String(status || "").toUpperCase();
  if (["SHOPEE_DELETE", "SELLER_DELETE", "DELETED", "BANNED"].includes(normalized)) return "final";
  if (normalized === "REVIEWING") return "review";
  return null;
}
