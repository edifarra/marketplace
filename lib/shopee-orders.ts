import { registerMarketplaceSale } from "./inventory";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { supabaseAdmin } from "./supabase-admin";

const orderProcessingQueues = new Map<string, Promise<unknown>>();

export function processShopeeOrderSynchronized(
  orderSn: string,
  account: ShopeeAccountConfig,
  notification: Record<string, any> = {},
  suppliedOrder?: Record<string, any>,
  activityId?: string
) {
  const queueKey = `${account.id}:${orderSn}`;
  const previous = orderProcessingQueues.get(queueKey) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => processShopeeOrder(orderSn, account, notification, suppliedOrder, activityId))
    .finally(() => {
      if (orderProcessingQueues.get(queueKey) === current) orderProcessingQueues.delete(queueKey);
    });
  orderProcessingQueues.set(queueKey, current);
  return current;
}

export async function processShopeeOrder(
  orderSn: string,
  account: ShopeeAccountConfig,
  notification: Record<string, any> = {},
  suppliedOrder?: Record<string, any>,
  activityId?: string
) {
  const shopId = String(account.shop_id || account.account_id || "");
  if (!shopId) throw new Error(`Shop ID nao configurado para ${account.name}.`);
  const accessToken = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const order = suppliedOrder && hasOrderItems(suppliedOrder)
    ? suppliedOrder
    : extractFirstOrder(await client.getOrderDetails(accessToken, shopId, [orderSn]));
  if (!order || !String(order.order_sn || order.ordersn || orderSn)) {
    throw new Error(`Pedido Shopee ${orderSn} nao encontrado.`);
  }

  const status = String(order.order_status || order.status || "unknown");
  const updateTime = String(order.update_time || notification.update_time || notification.timestamp || "");
  if (await isOlderThanSavedOrder(orderSn, updateTime)) {
    return { stale: true, orderSn, status, updateTime };
  }
  const items = order.item_list || order.items || [];
  const packageList = Array.isArray(order.package_list) ? order.package_list : [];
  const shipmentId = String(
    order.package_number
    || packageList[0]?.package_number
    || ""
  );
  const previousHistory = await getSavedShopeeHistory(orderSn);
  const trackingInfo = await fetchShopeeTrackingInfo(client, accessToken, shopId, orderSn, shipmentId);
  const shopeeHistory = mergeShopeeHistory(previousHistory, trackingInfo, {
    orderStatus: status,
    logisticsStatus: String(packageList[0]?.logistics_status || ""),
    occurredAt: updateTime || order.update_time || notification.timestamp || Date.now()
  });

  return registerMarketplaceSale({
    activityId,
    marketplace: "shopee",
    externalEventId: String(
      notification.request_id ? `${notification.request_id}:${orderSn}`
      : notification.event_id ? `${notification.event_id}:${orderSn}`
      : `shopee:${shopId}:${orderSn}:${status}:${updateTime}`
    ),
    eventType: String(notification.code || notification.event || (notification.recovery ? "order_reconciliation" : "notification")),
    externalOrderId: String(order.order_sn || order.ordersn || orderSn),
    externalListingId: order.item_id || items[0]?.item_id,
    status,
    mappingStatus: status,
    mappingSubstatus: String(order.order_substatus || order.substatus || packageList[0]?.logistics_status || ""),
    items: items.map((item: Record<string, any>) => ({
      sku: String(item.model_sku || item.item_sku || item.sku || ""),
      title: String(item.item_name || item.model_name || ""),
      quantity: Number(item.model_quantity_purchased || item.quantity_purchased || item.quantity || 1),
      unitPrice: Number(item.model_discounted_price || item.discounted_price || item.model_original_price || 0)
    })),
    value: Number(order.total_amount || 0),
    shipping: Number(order.actual_shipping_fee_confirmed ?? order.actual_shipping_fee ?? 0),
    shipmentId,
    marketplaceAccountId: account.id,
    marketplaceNickname: account.name,
    soldAt: shopeeDate(order.create_time || order.create_time_timestamp),
    rawPayload: { notification, order, shopeeHistory, trackingInfo }
  });
}

async function getSavedShopeeHistory(orderSn: string) {
  const { data, error } = await supabaseAdmin().from("venda").select("raw_data")
    .eq("marketplace", "shopee").eq("order_id", orderSn).maybeSingle();
  if (error) throw new Error(error.message);
  const raw = (data?.raw_data || {}) as Record<string, any>;
  return Array.isArray(raw.payload?.shopeeHistory) ? raw.payload.shopeeHistory : [];
}

async function fetchShopeeTrackingInfo(
  client: ReturnType<typeof createShopeeClient>,
  accessToken: string,
  shopId: string,
  orderSn: string,
  packageNumber: string
) {
  try {
    const result = await client.getTrackingInfo(accessToken, shopId, orderSn, packageNumber || undefined);
    const response = (result.response || result) as Record<string, any>;
    return Array.isArray(response.tracking_info) ? response.tracking_info : [];
  } catch {
    // A Shopee pode ainda não liberar o rastreamento antes de o envio ser organizado.
    return [];
  }
}

function mergeShopeeHistory(
  saved: Array<Record<string, any>>,
  tracking: Array<Record<string, any>>,
  observed: { orderStatus: string; logisticsStatus: string; occurredAt: unknown }
) {
  const events: Array<Record<string, any>> = [
    ...saved,
    ...tracking.map((event) => ({
      date: shopeeDate(event.update_time || event.create_time || event.time),
      status: String(event.logistics_status || event.status || ""),
      description: String(event.description || event.logistics_status || event.status || ""),
      source: "shopee_tracking"
    })),
    {
      date: shopeeDate(observed.occurredAt),
      status: observed.logisticsStatus || observed.orderStatus,
      order_status: observed.orderStatus,
      description: observed.logisticsStatus || observed.orderStatus,
      source: "observed"
    }
  ].filter((event) => event.date && event.status);
  const unique = new Map<string, Record<string, any>>();
  for (const event of events) {
    const key = `${event.date}|${event.status}|${event.order_status || ""}`;
    unique.set(key, event);
  }
  return [...unique.values()].sort((left, right) =>
    new Date(String(left.date)).getTime() - new Date(String(right.date)).getTime()
  );
}

async function isOlderThanSavedOrder(orderSn: string, incomingUpdateTime: string) {
  const incoming = normalizeTimestamp(incomingUpdateTime);
  if (!incoming) return false;
  const { data, error } = await supabaseAdmin()
    .from("venda")
    .select("raw_data")
    .eq("marketplace", "shopee")
    .eq("order_id", orderSn)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const raw = (data?.raw_data || {}) as Record<string, any>;
  const saved = normalizeTimestamp(raw.payload?.order?.update_time);
  return Boolean(saved && saved > incoming);
}

function normalizeTimestamp(value: unknown) {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(String(value)).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function listRecentlyUpdatedShopeeOrders(account: ShopeeAccountConfig, hours = 72) {
  const shopId = String(account.shop_id || account.account_id || "");
  if (!shopId) throw new Error(`Shop ID nao configurado para ${account.name}.`);
  const accessToken = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - Math.min(Math.max(hours, 1), 15 * 24) * 3600;
  const refs: Array<Record<string, any>> = [];
  let cursor = "";
  do {
    const page = await client.getOrderList(accessToken, shopId, timeFrom, timeTo, cursor);
    const response = (page.response || page) as Record<string, any>;
    refs.push(...(Array.isArray(response.order_list) ? response.order_list : []));
    cursor = response.more ? String(response.next_cursor || "") : "";
  } while (cursor);
  return refs;
}

function extractFirstOrder(payload: Record<string, unknown>) {
  const response = (payload.response || payload) as Record<string, any>;
  return (Array.isArray(response.order_list) ? response.order_list[0] : null) as Record<string, any> | null;
}

function hasOrderItems(order: Record<string, any>) {
  return Array.isArray(order.item_list || order.items) && (order.item_list || order.items).length > 0;
}

function shopeeDate(value: unknown) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
