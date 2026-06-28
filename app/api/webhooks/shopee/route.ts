import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { registerMarketplaceSale } from "@/lib/inventory";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const order = payload.data || payload.response || payload;
  const orderId = String(order.ordersn || order.order_sn || randomUUID());
  const sku = String(order.item_sku || order.sku || order.items?.[0]?.item_sku || "");
  const quantity = Number(order.quantity || order.items?.[0]?.quantity_purchased || 1);

  if (!sku) {
    return NextResponse.json({ accepted: false, reason: "SKU nao encontrado no payload" }, { status: 202 });
  }

  const result = await registerMarketplaceSale({
    marketplace: "shopee",
    externalOrderId: orderId,
    externalListingId: order.item_id || order.items?.[0]?.item_id,
    sku,
    quantity,
    rawPayload: payload
  });

  return NextResponse.json({ ok: true, result });
}
