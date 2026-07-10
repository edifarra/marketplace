import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase-admin";
import { getMarketplaceClient } from "./marketplaces";
import { Marketplace } from "./types";

export type MarketplaceSaleInput = {
  marketplace: Marketplace;
  externalEventId?: string;
  eventType?: string;
  externalOrderId?: string;
  externalListingId?: string;
  status?: string;
  items?: Array<{ sku: string; quantity: number; unitPrice?: number; totalPrice?: number }>;
  sku?: string;
  quantity?: number;
  value?: number;
  shipping?: number;
  fees?: number;
  discounts?: number;
  shipmentId?: string;
  rawPayload: unknown;
};

export async function registerMarketplaceSale(input: MarketplaceSaleInput) {
  const supabase = supabaseAdmin();
  const eventId = input.externalEventId || payloadHash(input.rawPayload);
  const orderId = String(input.externalOrderId || "").trim();
  const items = normalizeItems(input);

  const activityResult = await supabase.from("marketplace_activities").insert({
    marketplace: input.marketplace,
    event_type: input.eventType || "notification",
    external_event_id: eventId,
    order_id: orderId || null,
    description: input.eventType || "Evento recebido",
    value: number(input.value),
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    status: "received",
    raw_payload: input.rawPayload
  }).select("id").single();

  if (activityResult.error && /duplicate|unique/i.test(activityResult.error.message)) {
    return { duplicated: true, eventId };
  }
  if (activityResult.error) throw activityResult.error;
  const activityId = String(activityResult.data.id);
  await history(activityId, "received", "success", { eventId, orderId });

  try {
    if (!orderId) throw new Error("ID da venda nao encontrado no evento.");
    if (items.length === 0) throw new Error("Nenhum item com SKU encontrado no evento.");

    const status = String(input.status || "unknown");
    const statusResult = await supabase.from("status_venda")
      .select("id,reserves_stock,final_status")
      .eq("marketplace", input.marketplace).eq("external_status", status).maybeSingle();

    const vendaResult = await supabase.from("venda").upsert({
      marketplace: input.marketplace,
      order_id: orderId,
      status_id: statusResult.data?.id || null,
      status_original: status,
      valor_produtos: number(input.value) || items.reduce((sum, item) => sum + item.totalPrice, 0),
      valor_frete: number(input.shipping),
      valor_taxas: number(input.fees),
      valor_descontos: number(input.discounts),
      valor_liquido: number(input.value) + number(input.shipping) - number(input.fees) - number(input.discounts),
      shipment_id: input.shipmentId || null,
      raw_data: input.rawPayload,
      updated_at: new Date().toISOString()
    }, { onConflict: "marketplace,order_id" }).select("id").single().throwOnError();
    const vendaId = String(vendaResult.data.id);

    for (const item of items) {
      const productId = await ensureProduct(input.marketplace, item.sku, input.externalListingId, item.unitPrice);
      await supabase.from("venda_item").upsert({
        venda_id: vendaId, order_id: orderId, sku: item.sku, quantidade: item.quantity,
        valor_unitario: item.unitPrice, valor_total: item.totalPrice, raw_data: input.rawPayload
      }, { onConflict: "venda_id,sku" }).throwOnError();
      if (statusResult.data?.reserves_stock) await reserveStock(productId, item.quantity);
    }

    await supabase.from("marketplace_activities").update({
      venda_id: vendaId, status: "processed", processed_at: new Date().toISOString()
    }).eq("id", activityId).throwOnError();
    await history(activityId, "completed", "success", { vendaId, items: items.length });
    return { duplicated: false, activityId, vendaId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("marketplace_activities").update({ status: "error", processing_error: message, processed_at: new Date().toISOString() }).eq("id", activityId);
    await history(activityId, "processing", "error", { error: message });
    throw error;
  }
}

async function ensureProduct(marketplace: Marketplace, sku: string, listingId?: string, price = 0) {
  const supabase = supabaseAdmin();
  let result = await supabase.from("products").select("id").eq("sku", sku).maybeSingle().throwOnError();
  if (!result.data) {
    result = await supabase.from("products").insert({
      sku, source_key: `marketplace_${marketplace}_${sku}`, model: sku,
      title: `Produto ${sku}`, price, status: "active"
    }).select("id").single().throwOnError();
  }
  if (!result.data) throw new Error(`Nao foi possivel criar o produto ${sku}.`);
  const productId = String(result.data.id);
  await supabase.from("estoque").upsert({ product_id: productId, sku, estoque_fisico: 0, estoque_disponivel: 0 }, { onConflict: "product_id" }).throwOnError();
  await supabase.from("listings").upsert({
    product_id: productId, marketplace, external_listing_id: listingId || null,
    external_sku: sku, status: "active", stock: 0, price
  }, { onConflict: "product_id,marketplace" }).throwOnError();
  return productId;
}

async function reserveStock(productId: string, quantity: number) {
  const supabase = supabaseAdmin();
  const current = await supabase.from("estoque").select("estoque_fisico").eq("product_id", productId).single().throwOnError();
  const stock = Math.max(number(current.data.estoque_fisico) - quantity, 0);
  await supabase.from("estoque").update({ estoque_fisico: stock }).eq("product_id", productId).throwOnError();
  await syncListingsStock(productId, stock);
}

export async function syncListingsStock(productId: string, stock: number) {
  const supabase = supabaseAdmin();
  const result = await supabase.from("listings").select("id,marketplace,external_listing_id").eq("product_id", productId).throwOnError();
  for (const listing of result.data || []) {
    if (!listing.external_listing_id) continue;
    const client = getMarketplaceClient(listing.marketplace);
    if (stock <= 0) await client.pauseListing(listing.external_listing_id);
    else await client.updateStock(listing.external_listing_id, stock);
    await supabase.from("listings").update({ stock, status: stock <= 0 ? "paused" : "active", last_sync_at: new Date().toISOString(), error_message: null }).eq("id", listing.id).throwOnError();
  }
}

async function history(activityId: string, stage: string, status: string, details: Record<string, unknown>) {
  await supabaseAdmin().from("marketplace_activity_history").insert({ activity_id: activityId, stage, status, details });
}

function normalizeItems(input: MarketplaceSaleInput) {
  const source = input.items?.length ? input.items : input.sku ? [{ sku: input.sku, quantity: input.quantity || 1 }] : [];
  return source.map(item => ({ sku: String(item.sku || "").trim(), quantity: Math.max(1, number(item.quantity)), unitPrice: number(item.unitPrice), totalPrice: number(item.totalPrice) || number(item.unitPrice) * Math.max(1, number(item.quantity)) })).filter(item => item.sku);
}
function number(value: unknown) { const parsed = Number(value || 0); return Number.isFinite(parsed) ? parsed : 0; }
function payloadHash(payload: unknown) { return createHash("sha256").update(JSON.stringify(payload) + randomUUID().slice(0, 0)).digest("hex"); }
