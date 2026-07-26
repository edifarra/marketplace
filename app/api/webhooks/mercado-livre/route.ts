import { NextRequest, NextResponse } from "next/server";
import { getMercadoLivreAccountForNotification } from "@/lib/mercado-livre";
import { processMercadoLivreOrder, processMercadoLivreShipment } from "@/lib/mercado-livre-orders";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  try {
    if (payload.topic === "shipments") {
      const shipmentId = extractResourceId(payload, "shipments");
      if (!shipmentId) throw new Error("ID da entrega nao encontrado na notificacao.");
      const account = await getMercadoLivreAccountForNotification(payload.user_id);
      const result = await processMercadoLivreShipment(shipmentId, account, payload);
      return NextResponse.json({ ok: true, result });
    }
    if (payload.topic && payload.topic !== "orders_v2") {
      return NextResponse.json({ ok: true, ignored: true, topic: payload.topic });
    }
    const orderId = extractOrderId(payload);
    if (!orderId) throw new Error("ID da venda nao encontrado na notificacao.");
    const account = await getMercadoLivreAccountForNotification(payload.user_id);
    const result = await processMercadoLivreOrder(orderId, account, payload);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ accepted: true, processed: false, error: error instanceof Error ? error.message : String(error) }, { status: 202 });
  }
}

function extractResourceId(payload: Record<string, any>, resourceName: string) {
  const resource = String(payload.resource || "");
  return String(resource.match(new RegExp(`${resourceName}/(\\d+)`))?.[1] || "");
}

function extractOrderId(payload: Record<string, any>) {
  const resource = String(payload.resource || "");
  return String(payload.order_id || payload.order?.id || resource.match(/orders\/(\d+)/)?.[1] || payload.id || "");
}
