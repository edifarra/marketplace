import { NextRequest, NextResponse } from "next/server";
import { getMercadoLivreAccountForNotification } from "@/lib/mercado-livre";
import { processMercadoLivreOrder, processMercadoLivreShipment } from "@/lib/mercado-livre-orders";
import { supabaseAdmin } from "@/lib/supabase-admin";

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
    const message = error instanceof Error ? error.message : String(error);
    await logWebhookFailure(payload, message);
    // Status 5xx informa ao Mercado Livre que o evento nao foi processado e
    // permite uma nova tentativa. Responder 202 fazia a notificacao se perder.
    return NextResponse.json({ accepted: false, processed: false, error: message }, { status: 500 });
  }
}

async function logWebhookFailure(payload: Record<string, any>, message: string) {
  const resource = String(payload.resource || "");
  const orderId = payload.topic === "orders_v2" ? extractOrderId(payload) || null : null;
  const eventId = String(payload._id || payload.id || `webhook-error:${payload.topic || "unknown"}:${resource}:${payload.sent || Date.now()}`);
  const result = await supabaseAdmin().from("marketplace_activities").insert({
    marketplace: "mercado_livre",
    event_type: String(payload.topic || payload.type || "notification"),
    external_event_id: eventId,
    order_id: orderId,
    description: `Falha no webhook: ${resource || "recurso nao informado"}`,
    status: "error",
    raw_payload: payload,
    processing_error: message,
    processed_at: new Date().toISOString()
  });
  if (result.error && !/duplicate|unique/i.test(result.error.message)) {
    console.error("[mercado_livre_webhook_log]", result.error);
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
