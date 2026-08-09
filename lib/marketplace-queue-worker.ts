import { getMercadoLivreAccountForNotification } from "./mercado-livre";
import { processMercadoLivreOrder, processMercadoLivreShipment } from "./mercado-livre-orders";
import {
  completeQueuedActivity,
  retryQueuedActivity
} from "./marketplace-queue";
import { processShopeeOrderSynchronized } from "./shopee-orders";
import { supabaseAdmin } from "./supabase-admin";
import { activityDescription } from "./marketplace-activity-labels";

const SHOPEE_ORDER_PUSH_CODES = new Set([3, 4, 15, 29, 30, 37, 47]);
const SHOPEE_ACCOUNT_PUSH_CODES = new Set([1, 2, 12]);

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
  const payload = (activity.raw_payload || {}) as Record<string, any>;
  const topic = String(payload.topic || payload.type || "notification");
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

  const orderId = extractMercadoLivreOrderId(payload);
  if (!orderId) throw new Error("ID da venda nao encontrado na notificacao.");
  return processMercadoLivreOrder(orderId, account, payload, undefined, undefined, String(activity.id));
}

async function processShopeeActivity(activity: Record<string, any>) {
  const payload = (activity.raw_payload || {}) as Record<string, any>;
  const code = Number(payload.code || 0);
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
