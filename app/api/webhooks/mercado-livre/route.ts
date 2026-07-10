import { NextRequest, NextResponse } from "next/server";
import { registerMarketplaceSale } from "@/lib/inventory";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  try {
    const result = await registerMarketplaceSale({
      marketplace: "mercado_livre",
      externalEventId: String(payload.id || payload._id || ""),
      eventType: String(payload.topic || payload.type || "notification"),
      externalOrderId: extractOrderId(payload),
      externalListingId: payload.item_id || payload.order_items?.[0]?.item?.id,
      status: String(payload.status || "unknown"),
      items: (payload.order_items || []).map((item: Record<string, any>) => ({
        sku: String(item.item?.seller_sku || item.seller_sku || ""), quantity: Number(item.quantity || 1),
        unitPrice: Number(item.unit_price || 0), totalPrice: Number(item.full_unit_price || item.unit_price || 0) * Number(item.quantity || 1)
      })),
      sku: String(payload.sku || payload.seller_sku || ""), quantity: Number(payload.quantity || 1),
      value: Number(payload.total_amount || 0), shipping: Number(payload.shipping?.cost || 0), rawPayload: payload
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ accepted: true, processed: false, error: error instanceof Error ? error.message : String(error) }, { status: 202 });
  }
}

function extractOrderId(payload: Record<string, any>) {
  const resource = String(payload.resource || "");
  return String(payload.order_id || payload.order?.id || resource.match(/orders\/(\d+)/)?.[1] || payload.id || "");
}
