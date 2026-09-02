import { NextRequest, NextResponse } from "next/server";
import { enqueueMarketplaceActivity, marketplaceEventId } from "@/lib/marketplace-queue";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let payload: Record<string, any>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ accepted: false, error: "Payload JSON invalido." }, { status: 400 });
  }

  try {
    const topic = String(payload.topic || payload.type || "notification");
    const orderId = topic === "orders_v2" ? extractOrderId(payload) : null;
    const resource = String(payload.resource || "");
    const queued = await enqueueMarketplaceActivity({
      marketplace: "mercado_livre",
      payload,
      eventType: topic,
      externalEventId: marketplaceEventId("mercado_livre", payload),
      orderId,
      description: `Evento enfileirado: ${topic}${resource ? ` (${resource})` : ""}`
    });
    return NextResponse.json({ accepted: true, queued: true, id: queued.id }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      accepted: false,
      error: error instanceof Error ? error.message : String(error)
    }, { status: 503 });
  }
}

function extractOrderId(payload: Record<string, any>) {
  const resource = String(payload.resource || "");
  return String(payload.order_id || payload.order?.id || resource.match(/orders\/(\d+)/)?.[1] || payload.id || "");
}
