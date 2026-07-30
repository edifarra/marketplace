import { registerMarketplaceSale } from "./inventory";
import {
  MarketplaceAccountConfig,
  getMercadoLivreOrder,
  getMercadoLivrePack,
  getMercadoLivreShipment,
  getMercadoLivreShipmentHistory,
  getMercadoLivreShipmentItems,
  getMercadoLivreShipmentSla
} from "./mercado-livre";
import { supabaseAdmin } from "./supabase-admin";

export async function processMercadoLivreOrder(
  orderId: string,
  account: MarketplaceAccountConfig,
  notification: Record<string, any> = {},
  statusOverride?: string,
  supplementalPayload?: Record<string, any>,
  activityId?: string
) {
  const order = await getMercadoLivreOrder(orderId, account);
  const shipmentId = String(order.shipping?.id || "");
  const [shipment, shipmentHistory, shipmentSla]: [Record<string, any>, Array<Record<string, any>>, Record<string, any>] = shipmentId
    ? await Promise.all([
        getMercadoLivreShipment(shipmentId, account),
        getMercadoLivreShipmentHistory(shipmentId, account),
        getMercadoLivreShipmentSla(shipmentId, account).catch(() => ({}))
      ])
    : [{}, [], {}];
  // Mudancas de transporte nem sempre alteram date_last_updated do pedido.
  // A identidade da reconciliacao precisa acompanhar tambem a entrega para
  // que um novo status nao seja descartado como evento duplicado.
  const updated = String(
    shipment.last_updated
    || shipment.status_history?.date_shipped
    || order.date_last_updated
    || notification.sent
    || order.date_created
    || ""
  );
  const eventVersion = [
    updated,
    String(shipment.status || ""),
    String(shipment.substatus || "")
  ].join(":");
  const currentShippingStatus = normalizeMercadoLivreShippingStatus(shipment);
  const fees = (order.order_items || []).reduce((total: number, item: Record<string, any>) => total + Number(item.sale_fee || 0), 0);
  const shippingCost = (order.payments || []).reduce((total: number, payment: Record<string, any>) => total + Number(payment.shipping_cost || 0), 0);
  return registerMarketplaceSale({
    activityId,
    marketplace: "mercado_livre",
    externalEventId: String(notification._id || `orders_v2:${order.id || orderId}:${eventVersion}`),
    eventType: String(notification.topic || "orders_v2"),
    externalOrderId: String(order.id || orderId),
    externalListingId: order.order_items?.[0]?.item?.id,
    status: String(statusOverride || currentShippingStatus || order.status || "unknown"),
    mappingStatus: String(shipment.status || order.status || "unknown"),
    mappingSubstatus: String(shipment.substatus || ""),
    items: (order.order_items || []).map((item: Record<string, any>) => ({
      sku: String(item.item?.seller_sku || item.item?.seller_custom_field || item.seller_sku || ""),
      title: String(item.item?.title || ""),
      quantity: Number(item.quantity || 1),
      unitPrice: Number(item.unit_price || 0),
      totalPrice: Number(item.full_unit_price || item.unit_price || 0) * Number(item.quantity || 1)
    })),
    value: Number(order.total_amount || order.paid_amount || 0),
    shipping: shippingCost,
    fees,
    shipmentId,
    marketplaceAccountId: account.id,
    marketplaceNickname: account.nickname || account.name,
    soldAt: String(order.date_created || ""),
    rawPayload: { notification, order, shipment, shipmentHistory, shipmentSla, ...supplementalPayload }
  });
}

export async function processMercadoLivreShipment(
  shipmentId: string,
  account: MarketplaceAccountConfig,
  notification: Record<string, any> = {},
  activityId?: string
) {
  const [shipment, shipmentHistory, shipmentItems] = await Promise.all([
    getMercadoLivreShipment(shipmentId, account),
    getMercadoLivreShipmentHistory(shipmentId, account),
    // Algumas modalidades antigas ainda nao disponibilizam este recurso.
    // Nesses casos, os campos diretos ou o vinculo ja salvo continuam validos.
    getMercadoLivreShipmentItems(shipmentId, account).catch(() => [])
  ]);
  const orderIds = new Set<string>();
  addOrderId(orderIds, shipment.order_id);
  addOrderId(orderIds, shipment.order?.id);
  for (const order of shipment.orders || []) addOrderId(orderIds, order?.id || order?.order_id);
  for (const item of shipmentItems) addOrderId(orderIds, item.order_id || item.order?.id);

  if (!orderIds.size) {
    const savedOrders = await findSavedOrdersByShipment(shipmentId);
    for (const orderId of savedOrders) addOrderId(orderIds, orderId);
  }

  const packId = String(shipment.pack_id || shipment.pack?.id || "").trim();
  if (!orderIds.size && packId) {
    const pack = await getMercadoLivrePack(packId, account);
    for (const order of pack.orders || []) addOrderId(orderIds, order?.id || order?.order_id);
  }

  if (!orderIds.size) throw new Error(`Pedido da entrega ${shipmentId} nao identificado.`);
  const shipmentStatus = normalizeMercadoLivreShippingStatus(shipment);
  const results = [];
  let index = 0;
  for (const orderId of orderIds) {
    results.push(await processMercadoLivreOrder(
      orderId,
      account,
      notification,
      shipmentStatus,
      { shipment, shipmentHistory, shipmentItems },
      index === 0 ? activityId : undefined
    ));
    index += 1;
  }
  return results.length === 1 ? results[0] : results;
}

function addOrderId(orderIds: Set<string>, value: unknown) {
  const orderId = String(value || "").trim();
  if (/^\d+$/.test(orderId)) orderIds.add(orderId);
}

async function findSavedOrdersByShipment(shipmentId: string) {
  const { data, error } = await supabaseAdmin()
    .from("venda")
    .select("order_id")
    .eq("marketplace", "mercado_livre")
    .eq("shipment_id", shipmentId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => String(row.order_id || "")).filter(Boolean);
}

export function normalizeMercadoLivreShippingStatus(shipment: Record<string, any>) {
  const status = String(shipment.status || "").toLowerCase();
  const substatus = String(shipment.substatus || "").toLowerCase();

  if (["out_for_delivery", "first_visit"].includes(substatus)) return "out_for_delivery";
  if (["dropped_off", "picked_up", "in_hub", "in_packing_list"].includes(substatus)) return "shipped";
  if (status === "shipped") return "shipped";
  if (status === "delivered") return "delivered";
  return status || substatus || "unknown";
}
