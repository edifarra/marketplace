import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { registerMarketplaceSale } from "@/lib/inventory";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const orderId = String(payload.id || payload.resource || randomUUID());
  const sku = String(payload.sku || payload.seller_sku || payload.item?.seller_sku || "");
  const quantity = Number(payload.quantity || payload.order_items?.[0]?.quantity || 1);

  if (!sku) {
    return NextResponse.json({ accepted: false, reason: "SKU nao encontrado no payload" }, { status: 202 });
  }

  const result = await registerMarketplaceSale({
    marketplace: "mercado_livre",
    externalOrderId: orderId,
    externalListingId: payload.item_id || payload.order_items?.[0]?.item?.id,
    sku,
    quantity,
    rawPayload: payload
  });

  return NextResponse.json({ ok: true, result });
}
