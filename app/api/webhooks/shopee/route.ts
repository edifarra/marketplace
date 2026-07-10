import { NextRequest, NextResponse } from "next/server";
import { registerMarketplaceSale } from "@/lib/inventory";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const order = payload.data || payload.response || payload;
  try {
    const result = await registerMarketplaceSale({
      marketplace: "shopee", externalEventId: String(payload.request_id || payload.event_id || ""),
      eventType: String(payload.code || payload.event || "notification"),
      externalOrderId: String(order.ordersn || order.order_sn || ""),
      externalListingId: order.item_id || order.items?.[0]?.item_id,
      status: String(order.order_status || order.status || "unknown"),
      items: (order.items || order.item_list || []).map((item: Record<string, any>) => ({
        sku: String(item.model_sku || item.item_sku || item.sku || ""), quantity: Number(item.model_quantity_purchased || item.quantity_purchased || 1),
        unitPrice: Number(item.model_discounted_price || item.discounted_price || 0)
      })),
      sku: String(order.item_sku || order.sku || ""), quantity: Number(order.quantity || 1),
      value: Number(order.total_amount || 0), shipping: Number(order.actual_shipping_fee || 0), shipmentId: String(order.package_number || ""), rawPayload: payload
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ accepted: true, processed: false, error: error instanceof Error ? error.message : String(error) }, { status: 202 });
  }
}
