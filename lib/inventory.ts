import { supabaseAdmin } from "./supabase-admin";
import { getMarketplaceClient } from "./marketplaces";
import { Marketplace } from "./types";

export async function registerMarketplaceSale(input: {
  marketplace: Marketplace;
  externalOrderId: string;
  externalListingId?: string;
  sku: string;
  quantity: number;
  rawPayload: unknown;
}) {
  const supabase = supabaseAdmin();

  const existing = await supabase
    .from("orders")
    .select("id")
    .eq("marketplace", input.marketplace)
    .eq("external_order_id", input.externalOrderId)
    .maybeSingle();

  if (existing.data) {
    return { duplicated: true };
  }

  await supabase.from("orders").insert({
    marketplace: input.marketplace,
    external_order_id: input.externalOrderId,
    external_listing_id: input.externalListingId,
    sku: input.sku,
    quantity: input.quantity,
    raw_payload: input.rawPayload
  }).throwOnError();

  const productResult = await supabase
    .from("products")
    .select("id, stock")
    .eq("sku", input.sku)
    .single()
    .throwOnError();

  const product = productResult.data;
  const nextStock = Math.max(Number(product.stock || 0) - input.quantity, 0);

  await supabase
    .from("products")
    .update({ stock: nextStock, status: nextStock === 0 ? "paused" : "active", updated_at: new Date().toISOString() })
    .eq("id", product.id)
    .throwOnError();

  await syncListingsStock(product.id, nextStock);
  return { duplicated: false, stock: nextStock };
}

export async function syncListingsStock(productId: string, stock: number) {
  const supabase = supabaseAdmin();
  const listingsResult = await supabase
    .from("listings")
    .select("id, marketplace, external_listing_id")
    .eq("product_id", productId)
    .throwOnError();

  for (const listing of listingsResult.data || []) {
    if (!listing.external_listing_id) {
      continue;
    }

    const client = getMarketplaceClient(listing.marketplace);
    if (stock <= 0) {
      await client.pauseListing(listing.external_listing_id);
    } else {
      await client.updateStock(listing.external_listing_id, stock);
    }

    await supabase
      .from("listings")
      .update({
        stock,
        status: stock <= 0 ? "paused" : "active",
        last_sync_at: new Date().toISOString(),
        error_message: null
      })
      .eq("id", listing.id)
      .throwOnError();
  }
}
