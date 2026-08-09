import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase-admin";
import { getMarketplaceClient } from "./marketplaces";
import { Marketplace } from "./types";
import { salePostedAt } from "./sales-fulfillment";
import { activityDescription } from "./marketplace-activity-labels";

export type MarketplaceSaleInput = {
  activityId?: string;
  marketplace: Marketplace;
  externalEventId?: string;
  eventType?: string;
  externalOrderId?: string;
  externalListingId?: string;
  status?: string;
  mappingStatus?: string;
  mappingSubstatus?: string;
  items?: Array<{ sku: string; title?: string; quantity: number; unitPrice?: number; totalPrice?: number }>;
  sku?: string;
  quantity?: number;
  value?: number;
  shipping?: number;
  fees?: number;
  discounts?: number;
  shipmentId?: string;
  marketplaceAccountId?: string;
  marketplaceNickname?: string;
  soldAt?: string;
  rawPayload: unknown;
};

export async function registerMarketplaceSale(input: MarketplaceSaleInput) {
  const supabase = supabaseAdmin();
  const eventId = input.externalEventId || payloadHash(input.rawPayload);
  const orderId = String(input.externalOrderId || "").trim();
  const items = normalizeItems(input);

  let activityId = String(input.activityId || "");
  if (activityId) {
    await supabase.from("marketplace_activities").update({
      event_type: input.eventType || "notification",
      order_id: orderId || null,
      description: activityDescription(input.marketplace, String(input.eventType || "notification"), input.rawPayload as Record<string, any>),
      value: number(input.value),
      item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      status: "processing",
      raw_payload: input.rawPayload
    }).eq("id", activityId).throwOnError();
    await history(activityId, "sale_processing", "success", { eventId, orderId });
  } else {
    const activityResult = await supabase.from("marketplace_activities").insert({
      marketplace: input.marketplace,
      event_type: input.eventType || "notification",
      external_event_id: eventId,
      order_id: orderId || null,
      description: activityDescription(input.marketplace, String(input.eventType || "notification"), input.rawPayload as Record<string, any>),
      value: number(input.value),
      item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      status: "received",
      raw_payload: input.rawPayload
    }).select("id").single();

    if (activityResult.error && /duplicate|unique/i.test(activityResult.error.message)) {
      const existing = await supabase.from("marketplace_activities").select("id,status")
        .eq("marketplace", input.marketplace).eq("external_event_id", eventId).maybeSingle().throwOnError();
      if (existing.data?.status === "error") {
        await supabase.from("marketplace_activities").delete().eq("id", existing.data.id).throwOnError();
        return registerMarketplaceSale(input);
      }
      return { duplicated: true, eventId };
    }
    if (activityResult.error) throw activityResult.error;
    activityId = String(activityResult.data.id);
    await history(activityId, "received", "success", { eventId, orderId });
  }

  try {
    if (!orderId) throw new Error("ID da venda nao encontrado no evento.");
    if (items.length === 0) throw new Error("Nenhum item com SKU encontrado no evento.");

    const status = String(input.status || "unknown");
    const statusResult = await resolveSaleStatus(
      input.marketplace,
      String(input.mappingStatus || status),
      String(input.mappingSubstatus || "")
    );

    const previousSale = await supabase.from("venda")
      .select("id,raw_data")
      .eq("marketplace", input.marketplace).eq("order_id", orderId).maybeSingle().throwOnError();
    const previousRawData = (previousSale.data?.raw_data as Record<string, unknown> | null) || {};
    const detectedPostedAt = salePostedAt({
      marketplace: input.marketplace,
      status_original: status,
      raw_data: { payload: input.rawPayload }
    })?.toISOString();

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
      data_venda: input.soldAt || undefined,
      shipment_id: input.shipmentId || null,
      raw_data: {
        ...previousRawData,
        payload: input.rawPayload,
        marketplace_account_id: input.marketplaceAccountId || null,
        marketplace_nickname: input.marketplaceNickname || null,
        marketplace_posted_at: previousRawData.marketplace_posted_at || detectedPostedAt || null
      },
      updated_at: new Date().toISOString()
    }, { onConflict: "marketplace,order_id" }).select("id").single().throwOnError();
    const vendaId = String(vendaResult.data.id);

    for (const item of items) {
      const productId = await ensureProduct(input.marketplace, item.sku, input.externalListingId, item.unitPrice, item.title);
      await supabase.from("venda_item").upsert({
        venda_id: vendaId, order_id: orderId, sku: item.sku, quantidade: item.quantity,
        valor_unitario: item.unitPrice, valor_total: item.totalPrice, raw_data: input.rawPayload
      }, { onConflict: "venda_id,sku" }).throwOnError();
    }

    const transition = await supabase.rpc("reconcile_sale_inventory", {
      p_sale_id: vendaId,
      p_reserve: Boolean(statusResult.data?.reserves_stock),
      p_release: Boolean(statusResult.data?.releases_stock),
      p_deduct_physical: Boolean(statusResult.data?.deducts_physical_stock) || Boolean(detectedPostedAt)
    }).throwOnError();
    for (const inventory of transition.data || []) {
      await syncListingsStock(String(inventory.product_id), number(inventory.estoque_disponivel), {
        marketplace: input.marketplace,
        accountId: input.marketplaceAccountId
      });
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

const STATUS_SEPARATOR = "::";

async function resolveSaleStatus(marketplace: Marketplace, externalStatus: string, externalSubstatus: string) {
  const supabase = supabaseAdmin();
  const status = externalStatus.trim() || "unknown";
  const substatus = externalSubstatus.trim();
  const compoundStatus = substatus ? `${status}${STATUS_SEPARATOR}${substatus}` : status;

  const exact = await supabase.from("status_venda")
    .select("id,reserves_stock,final_status,deducts_physical_stock,releases_stock")
    .eq("marketplace", marketplace).eq("external_status", compoundStatus).maybeSingle().throwOnError();
  if (exact.data || !substatus) return exact;

  const fallback = await supabase.from("status_venda")
    .select("internal_status,description,reserves_stock,final_status,deducts_physical_stock,releases_stock")
    .eq("marketplace", marketplace).eq("external_status", status).maybeSingle().throwOnError();
  const inferred = inferDefaultStatusMapping(status, substatus);
  const inserted = await supabase.from("status_venda").insert({
    marketplace,
    external_status: compoundStatus,
    internal_status: inferred.internalStatus || fallback.data?.internal_status || status.toLowerCase(),
    description: inferred.description || fallback.data?.description || `${status} / ${substatus}`,
    reserves_stock: inferred.reservesStock ?? fallback.data?.reserves_stock ?? false,
    final_status: inferred.finalStatus ?? fallback.data?.final_status ?? false,
    deducts_physical_stock: inferred.deductsPhysical ?? fallback.data?.deducts_physical_stock ?? false,
    releases_stock: inferred.releasesStock ?? fallback.data?.releases_stock ?? false
  }).select("id,reserves_stock,final_status,deducts_physical_stock,releases_stock").single();
  if (inserted.error && /duplicate|unique/i.test(inserted.error.message)) {
    return supabase.from("status_venda")
      .select("id,reserves_stock,final_status,deducts_physical_stock,releases_stock")
      .eq("marketplace", marketplace).eq("external_status", compoundStatus).single().throwOnError();
  }
  if (inserted.error) throw inserted.error;
  return inserted;
}

function inferDefaultStatusMapping(status: string, substatus: string) {
  const normalizedStatus = status.toLowerCase();
  const normalizedSubstatus = substatus.toLowerCase();
  if (["out_for_delivery", "first_visit"].includes(normalizedSubstatus)) {
    return { internalStatus: "saiu_para_entrega", description: "Saiu para entrega", reservesStock: false, finalStatus: false, deductsPhysical: true, releasesStock: false };
  }
  if (["dropped_off", "picked_up", "in_hub", "in_packing_list"].includes(normalizedSubstatus) || normalizedStatus === "shipped") {
    return { internalStatus: "a_caminho", description: "A caminho", reservesStock: false, finalStatus: false, deductsPhysical: true, releasesStock: false };
  }
  if (normalizedStatus === "ready_to_ship" || normalizedStatus === "handling") {
    return { internalStatus: "pronta_para_envio", description: "Pronta para envio", reservesStock: true, finalStatus: false, deductsPhysical: false, releasesStock: false };
  }
  const cancelled = ["cancelled", "canceled", "refunded"].includes(normalizedStatus);
  return { internalStatus: "", description: "", reservesStock: cancelled ? false : true, finalStatus: undefined, deductsPhysical: false, releasesStock: cancelled };
}

async function ensureProduct(marketplace: Marketplace, sku: string, listingId?: string, price = 0, title = "") {
  const supabase = supabaseAdmin();
  let result = await supabase.from("products").select("id").eq("sku", sku).maybeSingle().throwOnError();
  if (!result.data) {
    result = await supabase.from("products").insert({
      sku, source_key: `marketplace_${marketplace}_${sku}`, model: sku,
      title: title.trim() || `Produto ${sku}`, price, status: "active"
    }).select("id").single().throwOnError();
  }
  if (!result.data) throw new Error(`Nao foi possivel criar o produto ${sku}.`);
  const productId = String(result.data.id);
  // Nao sobrescreve o saldo de um produto ja existente ao receber outra
  // notificacao da venda.
  await supabase.from("estoque").upsert({ product_id: productId, sku }, { onConflict: "product_id" }).throwOnError();
  const existingListing = await supabase.from("listings").select("id")
    .eq("product_id", productId).eq("marketplace", marketplace).limit(1).maybeSingle().throwOnError();
  const listingData = {
    product_id: productId, marketplace, external_listing_id: listingId || null,
    external_sku: sku, status: "active" as const, stock: 0, price
  };
  if (existingListing.data?.id) {
    await supabase.from("listings").update(listingData).eq("id", existingListing.data.id).throwOnError();
  } else {
    await supabase.from("listings").insert(listingData).throwOnError();
  }
  return productId;
}

export async function syncListingsStock(productId: string, stock: number, origin?: { marketplace?: string; accountId?: string }) {
  const supabase = supabaseAdmin();
  const setting = await supabase.from("settings").select("value").eq("key", "PRODUCT_SEND_TARGET").maybeSingle().throwOnError();
  if (String(setting.data?.value || "TINY") !== "MARKETPLACE_DIRETO") return;
  const result = await supabase.from("listings").select("id,marketplace,marketplace_account_id,external_listing_id").eq("product_id", productId).throwOnError();
  for (const listing of result.data || []) {
    if (!listing.external_listing_id) continue;
    if (origin?.accountId && listing.marketplace_account_id === origin.accountId) continue;
    if (!origin?.accountId && origin?.marketplace === listing.marketplace) continue;
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
  return source.map(item => ({ sku: String(item.sku || "").trim(), title: String((item as { title?: string }).title || "").trim(), quantity: Math.max(1, number(item.quantity)), unitPrice: number(item.unitPrice), totalPrice: number(item.totalPrice) || number(item.unitPrice) * Math.max(1, number(item.quantity)) })).filter(item => item.sku);
}
function number(value: unknown) { const parsed = Number(value || 0); return Number.isFinite(parsed) ? parsed : 0; }
function payloadHash(payload: unknown) { return createHash("sha256").update(JSON.stringify(payload) + randomUUID().slice(0, 0)).digest("hex"); }
