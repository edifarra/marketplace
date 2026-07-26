import { registerMarketplaceSale } from "./inventory";
import { MarketplaceAccountConfig, getMercadoLivreOrder, getMercadoLivreShipment, getMercadoLivreShipmentHistory } from "./mercado-livre";

export async function processMercadoLivreOrder(
  orderId: string,
  account: MarketplaceAccountConfig,
  notification: Record<string, any> = {},
  statusOverride?: string,
  supplementalPayload?: Record<string, any>
) {
  const order = await getMercadoLivreOrder(orderId, account);
  const shipmentId = String(order.shipping?.id || "");
  const [shipment, shipmentHistory]: [Record<string, any>, Array<Record<string, any>>] = shipmentId
    ? await Promise.all([
        getMercadoLivreShipment(shipmentId, account),
        getMercadoLivreShipmentHistory(shipmentId, account)
      ])
    : [{}, []];
  const updated = String(order.date_last_updated || order.date_created || notification.sent || "");
  const currentShippingStatus = shipment.substatus === "out_for_delivery"
    ? "out_for_delivery"
    : String(shipment.status || "");
  const fees = (order.order_items || []).reduce((total: number, item: Record<string, any>) => total + Number(item.sale_fee || 0), 0);
  const shippingCost = (order.payments || []).reduce((total: number, payment: Record<string, any>) => total + Number(payment.shipping_cost || 0), 0);
  return registerMarketplaceSale({
    marketplace: "mercado_livre",
    externalEventId: String(notification._id || `orders_v2:${order.id || orderId}:${updated}`),
    eventType: String(notification.topic || "orders_v2"),
    externalOrderId: String(order.id || orderId),
    externalListingId: order.order_items?.[0]?.item?.id,
    status: String(statusOverride || currentShippingStatus || order.status || "unknown"),
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
    rawPayload: { notification, order, shipment, shipmentHistory, ...supplementalPayload }
  });
}

export async function processMercadoLivreShipment(
  shipmentId: string,
  account: MarketplaceAccountConfig,
  notification: Record<string, any> = {}
) {
  const shipment = await getMercadoLivreShipment(shipmentId, account);
  const shipmentHistory = await getMercadoLivreShipmentHistory(shipmentId, account);
  const orderId = String(shipment.order_id || shipment.order?.id || shipment.orders?.[0]?.id || "");
  if (!orderId) throw new Error(`Pedido da entrega ${shipmentId} nao identificado.`);
  const shipmentStatus = shipment.substatus === "out_for_delivery"
    ? "out_for_delivery"
    : String(shipment.status || shipment.substatus || "unknown");
  return processMercadoLivreOrder(
    orderId,
    account,
    notification,
    shipmentStatus,
    { shipment, shipmentHistory }
  );
}
