import { registerMarketplaceSale } from "./inventory";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";

export async function processShopeeOrder(
  orderSn: string,
  account: ShopeeAccountConfig,
  notification: Record<string, any> = {},
  suppliedOrder?: Record<string, any>
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
  const items = order.item_list || order.items || [];
  const packageList = Array.isArray(order.package_list) ? order.package_list : [];
  const shipmentId = String(
    order.package_number
    || packageList[0]?.package_number
    || ""
  );

  return registerMarketplaceSale({
    marketplace: "shopee",
    externalEventId: String(
      notification.request_id
      || notification.event_id
      || `shopee:${shopId}:${orderSn}:${status}:${updateTime}`
    ),
    eventType: String(notification.code || notification.event || (notification.recovery ? "order_reconciliation" : "notification")),
    externalOrderId: String(order.order_sn || order.ordersn || orderSn),
    externalListingId: order.item_id || items[0]?.item_id,
    status,
    mappingStatus: status,
    mappingSubstatus: String(order.order_substatus || order.substatus || ""),
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
    rawPayload: { notification, order }
  });
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
