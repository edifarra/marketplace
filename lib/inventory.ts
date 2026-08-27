import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase-admin";
import { Marketplace } from "./types";
import { salePostedAt } from "./sales-fulfillment";
import { activityDescription } from "./marketplace-activity-labels";
import { notifyNewSale } from "./telegram-notifications";
import { drainOutgoingActivities, enqueueOutgoingActivity } from "./outgoing-activities";

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
      status: "processing"
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

  let vendaId = "";
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
    vendaId = String(vendaResult.data.id);

    for (const item of items) {
      const product = await ensureProduct(
        input.marketplace,
        item.sku,
        input.externalListingId,
        item.unitPrice,
        item.title,
        input.marketplaceAccountId
      );
      await supabase.from("venda_item").upsert({
        venda_id: vendaId, order_id: orderId, sku: product.sku, quantidade: item.quantity,
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

    const audit = await auditSaleInventory(vendaId);
    const failedAudit = audit.find((row) => String(row.status) !== "success");
    if (failedAudit) {
      throw new Error(`Auditoria de estoque falhou para ${failedAudit.sku}: ${failedAudit.mensagem}`);
    }

    await supabase.from("marketplace_activities").update({
      venda_id: vendaId, status: "processed", processed_at: new Date().toISOString()
    }).eq("id", activityId).throwOnError();
    await history(activityId, "completed", "success", { vendaId, items: items.length });
    // Toda atualizacao elegivel tenta a notificacao. A chave idempotente do
    // Telegram impede mensagens duplicadas e evita perder vendas que tenham
    // sido criadas antes por um evento preliminar ou por uma reconciliacao.
    await notifyNewSale(vendaId);
    return { duplicated: false, activityId, vendaId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (vendaId) {
      await auditSaleInventory(vendaId).catch((auditError) => {
        console.error("[sale_inventory_audit]", auditError);
      });
    }
    await supabase.from("marketplace_activities").update({ status: "error", processing_error: message, processed_at: new Date().toISOString() }).eq("id", activityId);
    await history(activityId, "processing", "error", { error: message });
    throw error;
  }
}

async function auditSaleInventory(vendaId: string) {
  const result = await supabaseAdmin().rpc("audit_sale_inventory", { p_sale_id: vendaId });
  if (result.error) throw new Error(`Falha ao auditar estoque da venda: ${result.error.message}`);
  return (result.data || []) as Array<{ sku: string; status: string; mensagem: string }>;
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

async function ensureProduct(
  marketplace: Marketplace,
  sku: string,
  listingId?: string,
  price = 0,
  title = "",
  marketplaceAccountId?: string
) {
  const supabase = supabaseAdmin();
  if (listingId && marketplaceAccountId) {
    const linked = await supabase.from("listings").select("product_id,external_sku,products(sku)")
      .eq("marketplace_account_id", marketplaceAccountId).eq("external_listing_id", listingId)
      .limit(1).maybeSingle().throwOnError();
    if (linked.data?.product_id) {
      const linkedProduct = linked.data.products as unknown as { sku?: string | null } | null;
      return { productId: String(linked.data.product_id), sku: String(linkedProduct?.sku || linked.data.external_sku || sku) };
    }
  }

  let result = await supabase.from("products").select("id,sku").eq("sku", sku).limit(1).maybeSingle().throwOnError();
  if (!result.data) {
    result = await supabase.from("products").select("id,sku").ilike("sku", sku).order("created_at").limit(1).maybeSingle().throwOnError();
  }
  if (!result.data) {
    result = await supabase.from("products").insert({
      sku, source_key: `marketplace_${marketplace}_${sku}`, model: sku,
      title: title.trim() || `Produto ${sku}`, price, status: "active"
    }).select("id,sku").single().throwOnError();
  }
  if (!result.data) throw new Error(`Nao foi possivel criar o produto ${sku}.`);
  const productId = String(result.data.id);
  // Nao sobrescreve o saldo de um produto ja existente ao receber outra
  // notificacao da venda.
  await supabase.from("estoque").upsert({ product_id: productId, sku }, { onConflict: "product_id" }).throwOnError();
  let existingListingQuery = supabase.from("listings").select("id")
    .eq("product_id", productId).eq("marketplace", marketplace);
  existingListingQuery = marketplaceAccountId
    ? existingListingQuery.eq("marketplace_account_id", marketplaceAccountId)
    : existingListingQuery.is("marketplace_account_id", null);
  const existingListing = await existingListingQuery.limit(1).maybeSingle().throwOnError();
  const listingData = {
    product_id: productId, marketplace, external_listing_id: listingId || null,
    marketplace_account_id: marketplaceAccountId || null,
    external_sku: sku, status: "active" as const, stock: 0, price
  };
  if (existingListing.data?.id) {
    await supabase.from("listings").update(listingData).eq("id", existingListing.data.id).throwOnError();
  } else {
    await supabase.from("listings").insert(listingData).throwOnError();
  }
  return { productId, sku: String(result.data.sku || sku) };
}

export async function syncListingsStock(productId: string, stock: number, origin?: { marketplace?: string; accountId?: string; sourceType?: string }, processImmediately = true) {
  const supabase = supabaseAdmin();
  const [result, legacyLinks, product, inventory] = await Promise.all([
    supabase.from("listings").select("id,marketplace,marketplace_account_id,external_listing_id,stock,status").eq("product_id", productId).throwOnError(),
    supabase.from("product_marketplaces").select("id,marketplace,marketplace_account_id,marketplace_product_id,estoque_marketplace,status_anuncio")
      .eq("product_id", productId).eq("existe_no_marketplace", true).throwOnError(),
    supabase.from("products").select("sku,title,tiny_product_id").eq("id", productId).single().throwOnError(),
    supabase.from("estoque").select("stock_version").eq("product_id", productId).single().throwOnError()
  ]);
  const targets = new Map<string, Record<string, any>>();
  for (const listing of result.data || []) targets.set(`${listing.marketplace_account_id}:${listing.external_listing_id}`, listing);
  for (const link of legacyLinks.data || []) {
    const key = `${link.marketplace_account_id}:${link.marketplace_product_id}`;
    if (!targets.has(key)) targets.set(key, { marketplace: link.marketplace, marketplace_account_id: link.marketplace_account_id,
      external_listing_id: link.marketplace_product_id, stock: link.estoque_marketplace, status: link.status_anuncio });
  }
  for (const listing of targets.values()) {
    if (!listing.external_listing_id || !listing.marketplace_account_id) continue;
    await enqueueOutgoingActivity({
      destination: listing.marketplace as "mercado_livre" | "shopee",
      activityType: "stock_update", productId, sku: String(product.data.sku), productName: String(product.data.title || ""),
      accountId: listing.marketplace_account_id, listingId: listing.external_listing_id,
      previousData: { stock: listing.stock, status: listing.status }, requestedData: {
        stock, status: stock <= 0 ? (listing.marketplace === "mercado_livre" ? "paused" : "zero") : "active"
      }, sourceType: origin?.sourceType || "sale", sourceId: null, stockVersion: Number(inventory.data.stock_version || 0)
    });
  }
  if (product.data.tiny_product_id) {
    await enqueueOutgoingActivity({ destination: "tiny", activityType: "stock_update", productId,
      sku: String(product.data.sku), productName: String(product.data.title || ""), listingId: String(product.data.tiny_product_id),
      previousData: {}, requestedData: { stock, status: stock > 0 ? "active" : "zero" }, sourceType: origin?.sourceType || "sale", sourceId: null,
      stockVersion: Number(inventory.data.stock_version || 0) });
  }
  // Processa imediatamente o primeiro lote; falhas permanecem na fila e sao
  // recolocadas no fim para as proximas tentativas.
  if (processImmediately) await drainOutgoingActivities();
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
