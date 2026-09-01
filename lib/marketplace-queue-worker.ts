import { getMercadoLivreAccountForNotification, getMercadoLivreItem, getMercadoLivreLastModeration } from "./mercado-livre";
import { processMercadoLivreOrder, processMercadoLivreShipment } from "./mercado-livre-orders";
import {
  completeQueuedActivity,
  retryQueuedActivity
} from "./marketplace-queue";
import { processShopeeOrderSynchronized } from "./shopee-orders";
import { supabaseAdmin } from "./supabase-admin";
import { activityDescription } from "./marketplace-activity-labels";
import { clearMarketplaceModeration, mercadoLivreModerationClass, recordMarketplaceModeration, shopeeModerationClass } from "./marketplace-moderations";
import { drainOutgoingActivities, enqueueOutgoingActivity } from "./outgoing-activities";
import { processMercadoLivreConversationNotification, processShopeeConversationNotification } from "./marketplace-conversations";

const SHOPEE_ORDER_PUSH_CODES = new Set([3, 4, 15, 29, 30, 37, 47]);
const SHOPEE_ACCOUNT_PUSH_CODES = new Set([1, 2, 12]);
const MERCADO_LIVRE_MODERATION_SUB_STATUSES = new Set([
  "warning", "waiting_for_patch", "held", "pending_documentation", "forbidden",
  "suspended", "suspended_for_prevention", "picture_download_pending", "picture_downloading_pending"
]);
const MERCADO_LIVRE_MODERATION_TAGS = new Set(["moderation_penalty", "poor_quality_thumbnail"]);

export async function processMarketplaceQueue(limit = 10) {
  const claim = await supabaseAdmin().rpc("claim_marketplace_activity_queue", {
    p_limit: Math.min(Math.max(limit, 1), 50)
  });
  if (claim.error) throw new Error(`Falha ao capturar fila: ${claim.error.message}`);

  const activities = (claim.data || []) as Array<Record<string, any>>;
  const results: Array<Record<string, unknown>> = [];
  for (const activity of activities) {
    try {
      const result = activity.marketplace === "shopee"
        ? await processShopeeActivity(activity)
        : activity.marketplace === "mercado_livre"
          ? await processMercadoLivreActivity(activity)
          : await completeQueuedActivity(String(activity.id), `Marketplace ${activity.marketplace} nao suportado.`, {
              ignored: true
            });
      results.push({ id: activity.id, marketplace: activity.marketplace, ok: true, result });
    } catch (error) {
      await retryQueuedActivity(activity, error);
      results.push({
        id: activity.id,
        marketplace: activity.marketplace,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    claimed: activities.length,
    processed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
}

async function processMercadoLivreActivity(activity: Record<string, any>) {
  const storedPayload = (activity.raw_payload || {}) as Record<string, any>;
  // Versoes anteriores sobrescreviam o envelope do webhook com os dados
  // completos do pedido durante uma tentativa que depois falhasse. Aceitar o
  // notification aninhado permite recuperar esses eventos sem perde-los.
  const payload = (storedPayload.notification || storedPayload) as Record<string, any>;
  const topic = String(payload.topic || payload.type || "notification");
  if (["questions", "messages"].includes(topic)) {
    const result = await processMercadoLivreConversationNotification(activity, payload);
    return completeQueuedActivity(String(activity.id), result?.description || "Conversa atualizada.", { topic, ...(result || {}) });
  }
  if (topic === "items") return processMercadoLivreItemActivity(activity, payload);
  if (topic !== "orders_v2" && topic !== "shipments") {
    return completeQueuedActivity(
      String(activity.id),
      activityDescription("mercado_livre", topic, payload),
      { topic, acknowledged: true }
    );
  }

  const account = await getMercadoLivreAccountForNotification(payload.user_id);
  if (topic === "shipments") {
    const shipmentId = extractResourceId(payload, "shipments");
    if (!shipmentId) throw new Error("ID da entrega nao encontrado na notificacao.");
    return processMercadoLivreShipment(shipmentId, account, payload, String(activity.id));
  }

  const orderId = extractMercadoLivreOrderId(payload) || String(storedPayload.order?.id || activity.order_id || "");
  if (!orderId) throw new Error("ID da venda nao encontrado na notificacao.");
  return processMercadoLivreOrder(orderId, account, payload, undefined, undefined, String(activity.id));
}

async function processMercadoLivreItemActivity(activity: Record<string, any>, payload: Record<string, any>) {
  const itemId = String(payload.resource || "").match(/\/items\/(ML[A-Z]\d+)/i)?.[1]?.toUpperCase();
  if (!itemId) throw new Error("ID do anuncio nao encontrado na notificacao.");
  const account = await getMercadoLivreAccountForNotification(payload.user_id);
  const item = await getMercadoLivreItem(itemId, account);
  const moderation = shouldFetchMercadoLivreModeration(item)
    ? await getMercadoLivreLastModeration(itemId, account)
    : [];
  const reason = moderation.flatMap(entry => entry.wordings || [])
    .find(wording => String(wording.type).toUpperCase() === "REASON")?.value;
  const remedy = moderation.flatMap(entry => entry.wordings || [])
    .find(wording => String(wording.type).toUpperCase() === "REMEDY")?.value;
  const rawData = { ...item, moderation, moderation_reason: reason || null, moderation_remedy: remedy || null };
  const db = supabaseAdmin();
  await db.from("product_marketplaces").update({
    titulo_marketplace: item.title || null,
    valor_marketplace: Number(item.price || 0),
    estoque_marketplace: Number(item.available_quantity || 0),
    status_anuncio: String(item.status || ""),
    raw_data: rawData,
    updated_at: new Date().toISOString()
  }).eq("marketplace_account_id", account.id).eq("marketplace_product_id", itemId).throwOnError();
  await db.from("listings").update({
    status: String(item.status) === "active" ? "active" : "paused",
    stock: Number(item.available_quantity || 0),
    price: Number(item.price || 0),
    error_message: reason || null,
    last_sync_at: new Date().toISOString()
  }).eq("marketplace_account_id", account.id).eq("external_listing_id", itemId).throwOnError();
  const classification = mercadoLivreModerationClass(String(item.status || ""), item.sub_status);
  if (classification) {
    const itemStatus = String(item.status || "").toLowerCase();
    const itemSubStatuses = (Array.isArray(item.sub_status) ? item.sub_status : []).map((value: unknown) => String(value).toLowerCase());
    const deletionWasValidated = itemStatus === "closed" || itemSubStatuses.includes("forbidden");
    if (classification === "final" && deletionWasValidated) {
      await deleteMarketplaceListingBeforeFinalization({
        activityId: String(activity.id),
        accountId: String(account.id),
        itemId,
        productName: String(item.title || itemId),
        sku: String(item.seller_custom_field || item.attributes?.find((attribute: Record<string, any>) => attribute.id === "SELLER_SKU")?.value_name || ""),
        reason: String(reason || "Anuncio finalizado pelo Mercado Livre.")
      });
    }
    await recordMarketplaceModeration({
      marketplace: "mercado_livre", accountId: account.id, storeName: String(account.nickname || account.name), listingId: itemId,
      sku: item.seller_custom_field || item.attributes?.find((attribute: Record<string, any>) => attribute.id === "SELLER_SKU")?.value_name,
      productName: item.title, status: String(item.status || ""), classification,
      reason: reason || (classification === "final" ? "Anuncio encerrado pelo Mercado Livre." : "Anuncio em revisao pelo Mercado Livre."),
      remedy: remedy || null, sourceEventId: String(activity.external_event_id || activity.id),
      eventAt: moderation[0]?.date_created || payload.sent || activity.received_at, rawData
    });
  } else {
    await clearMarketplaceModeration("mercado_livre", account.id, itemId);
  }
  await db.from("marketplace_activities").update({ raw_payload: { notification: payload, item, moderation } })
    .eq("id", activity.id).throwOnError();
  const finalStatus = String(item.status) === "under_review" && (item.sub_status || []).includes("forbidden")
    ? "Finalizado pelo Mercado Livre"
    : String(item.status || "Status desconhecido");
  return completeQueuedActivity(String(activity.id), `${finalStatus}${reason ? `: ${reason}` : "."}`, {
    topic: "items", itemId, itemStatus: item.status, itemSubStatus: item.sub_status || [], moderationReason: reason || null
  });
}

export function shouldFetchMercadoLivreModeration(item: Record<string, any>) {
  const status = String(item.status || "").toLowerCase();
  if (status === "under_review") return true;
  const subStatuses = Array.isArray(item.sub_status) ? item.sub_status : [];
  if (subStatuses.some((value: unknown) => MERCADO_LIVRE_MODERATION_SUB_STATUSES.has(String(value).toLowerCase()))) return true;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  return tags.some((value: unknown) => MERCADO_LIVRE_MODERATION_TAGS.has(String(value).toLowerCase()));
}

async function deleteMarketplaceListingBeforeFinalization(input: {
  activityId: string;
  accountId: string;
  itemId: string;
  productName: string;
  sku: string;
  reason: string;
}) {
  const db = supabaseAdmin();
  const sourceType = "marketplace_finalization_deletion";
  const existing = await db.from("outgoing_marketplace_activities")
    .select("id,status,processing_error")
    .eq("source_type", sourceType)
    .eq("source_id", input.activityId)
    .eq("marketplace_account_id", input.accountId)
    .eq("listing_id", input.itemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();

  const outgoingActivityId = existing.data?.id
    ? String(existing.data.id)
    : await enqueueOutgoingActivity({
        destination: "mercado_livre",
        activityType: "listing_delete",
        sku: input.sku || input.itemId,
        productName: input.productName,
        accountId: input.accountId,
        listingId: input.itemId,
        previousData: { status: "final", reason: input.reason },
        requestedData: { status: "deleted" },
        sourceType,
        sourceId: input.activityId
      });

  if (existing.data?.status !== "completed") await drainOutgoingActivities();
  const result = await db.from("outgoing_marketplace_activities")
    .select("status,processing_error")
    .eq("id", outgoingActivityId)
    .single()
    .throwOnError();
  if (result.data.status !== "completed") {
    throw new Error(result.data.processing_error || `A exclusao do anuncio ${input.itemId} nao foi confirmada pelo Mercado Livre.`);
  }
}

async function processShopeeActivity(activity: Record<string, any>) {
  const payload = (activity.raw_payload || {}) as Record<string, any>;
  const code = Number(payload.code || 0);
  if (code === 10) {
    const result = await processShopeeConversationNotification(payload);
    return completeQueuedActivity(String(activity.id), result.description, { code, ...result });
  }
  if (isShopeeVerificationPush(payload)) {
    return completeQueuedActivity(String(activity.id), "Teste de callback Shopee validado.", { code });
  }

  const shopId = String(payload.shop_id || payload.data?.shop_id || "");
  const accountResult = shopId
    ? await supabaseAdmin().from("config_marketplace_accounts")
        .select("*").eq("marketplace", "shopee").eq("shop_id", shopId).maybeSingle()
    : { data: null, error: null };
  if (accountResult.error) throw new Error(accountResult.error.message);
  const account = accountResult.data;
  if (account && !signatureMatchesAccount(String(activity.source_key || ""), String(account.name || ""))) {
    throw new Error(`Chave Push nao corresponde a loja ${account.name}.`);
  }

  if (SHOPEE_ACCOUNT_PUSH_CODES.has(code)) {
    if (!account) throw new Error(`Conta Shopee ${shopId || "nao informada"} nao encontrada.`);
    await processShopeeAccountPush(code, String(account.id));
    return completeQueuedActivity(String(activity.id), `Push de autorizacao Shopee ${code} processado.`, { code, shopId });
  }

  if (account && hasShopeeItemStatus(payload)) {
    return processShopeeItemStatusActivity(activity, payload, account);
  }

  const orderSns = extractShopeeOrderSns(payload);
  if (SHOPEE_ORDER_PUSH_CODES.has(code) && orderSns.length) {
    if (!account) throw new Error(`Conta Shopee ${shopId || "nao informada"} nao encontrada.`);
    const results = [];
    for (let index = 0; index < orderSns.length; index += 1) {
      results.push(await processShopeeOrderSynchronized(
        orderSns[index],
        account,
        payload,
        undefined,
        index === 0 ? String(activity.id) : undefined
      ));
    }
    return results;
  }

  return completeQueuedActivity(
    String(activity.id),
    SHOPEE_ORDER_PUSH_CODES.has(code)
      ? `Push Shopee ${code} reconhecido sem pedido identificavel.`
      : activityDescription("shopee", String(code || "notification"), payload),
    { code, acknowledged: true }
  );
}

async function processShopeeItemStatusActivity(activity: Record<string, any>, payload: Record<string, any>, account: Record<string, any>) {
  const data = (payload.data || {}) as Record<string, any>;
  const itemId = String(data.item_id || "");
  const status = String(data.item_status || data.status || "").toUpperCase();
  if (!itemId || !status) throw new Error("Status ou ID do anuncio nao encontrado no Push Shopee.");
  const details = Array.isArray(data.item_status_details) ? data.item_status_details : [];
  const detail = details[0] || {};
  const reason = String(detail.violation_reason || data.violation_reason || "") || null;
  const remedy = String(detail.suggestion || data.suggestion || "") || null;
  const classification = shopeeModerationClass(status);
  const db = supabaseAdmin();
  if (classification) {
    await recordMarketplaceModeration({
      marketplace: "shopee", accountId: String(account.id), storeName: String(account.nickname || account.name), listingId: itemId,
      productName: data.item_name, status, classification, reason: reason || (classification === "final" ? "Anuncio encerrado pela Shopee." : "Anuncio em revisao pela Shopee."),
      remedy, sourceEventId: String(payload.msg_id || activity.external_event_id || activity.id),
      eventAt: detail.update_time ? new Date(Number(detail.update_time) * 1000).toISOString() : activity.received_at,
      rawData: payload
    });
  } else {
    await clearMarketplaceModeration("shopee", String(account.id), itemId);
    await db.from("product_marketplaces").update({ status_anuncio: status, raw_data: payload, updated_at: new Date().toISOString() })
      .eq("marketplace_account_id", account.id).eq("marketplace_product_id", itemId).throwOnError();
  }
  const description = `${shopeeStatusLabel(status)}${reason ? `: ${reason}` : "."}`;
  return completeQueuedActivity(String(activity.id), description, { code: payload.code, itemId, itemStatus: status, reason, remedy });
}

function hasShopeeItemStatus(payload: Record<string, any>) {
  const data = payload.data || {};
  return Boolean(data.item_id && (data.item_status || data.status) && ([6, 16, 22].includes(Number(payload.code || 0)) || data.item_status_details));
}

function shopeeStatusLabel(status: string) {
  const labels: Record<string, string> = {
    SHOPEE_DELETE: "Anuncio removido definitivamente pela Shopee", SELLER_DELETE: "Anuncio excluido pelo vendedor",
    DELETED: "Anuncio excluido", BANNED: "Anuncio banido pela Shopee", REVIEWING: "Anuncio em revisao pela Shopee",
    UNLIST: "Anuncio inativo na Shopee", NORMAL: "Anuncio ativo na Shopee"
  };
  return labels[status] || `Status Shopee ${status}`;
}

async function processShopeeAccountPush(code: number, accountId: string) {
  const now = new Date().toISOString();
  const update = code === 2
    ? { status: "disconnected", last_error: "Autorizacao Shopee cancelada.", updated_at: now }
    : code === 12
      ? { last_error: "A Shopee informou que a autorizacao expirara em breve.", updated_at: now }
      : { status: "active", last_error: null, updated_at: now };
  const result = await supabaseAdmin().from("config_marketplace_accounts").update(update).eq("id", accountId);
  if (result.error) throw new Error(result.error.message);
}

function extractResourceId(payload: Record<string, any>, resourceName: string) {
  const resource = String(payload.resource || "");
  return String(resource.match(new RegExp(`${resourceName}/(\\d+)`))?.[1] || "");
}

function extractMercadoLivreOrderId(payload: Record<string, any>) {
  const resource = String(payload.resource || "");
  return String(payload.order_id || payload.order?.id || resource.match(/orders\/(\d+)/)?.[1] || payload.id || "");
}

function extractShopeeOrderSns(payload: Record<string, any>) {
  const found = new Set<string>();
  visit(payload.data || payload.response || payload, 0);
  return [...found];

  function visit(value: unknown, depth: number) {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (["ordersn", "order_sn"].includes(key.toLowerCase())) {
        const orderSn = String(entry || "").trim();
        if (orderSn) found.add(orderSn);
      } else if (["order_sn_list", "ordersn_list"].includes(key.toLowerCase()) && Array.isArray(entry)) {
        for (const item of entry) {
          const orderSn = String(item || "").trim();
          if (orderSn) found.add(orderSn);
        }
      } else {
        visit(entry, depth + 1);
      }
    }
  }
}

function signatureMatchesAccount(keyName: string, accountName: string) {
  const normalized = accountName.toUpperCase();
  if (normalized.includes("SP-ED")) return keyName === "ED";
  if (normalized.includes("SP-GI")) return keyName === "GI";
  return true;
}

function isShopeeVerificationPush(payload: Record<string, any>) {
  const code = String(payload.code ?? "").toLowerCase();
  return !payload.shop_id && ["", "0", "test", "verification"].includes(code);
}
