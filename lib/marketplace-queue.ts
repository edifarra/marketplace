import { createHash } from "crypto";
import { supabaseAdmin } from "./supabase-admin";
import { Marketplace } from "./types";

export type MarketplaceQueueInput = {
  marketplace: Marketplace;
  payload: Record<string, any>;
  eventType: string;
  orderId?: string | null;
  description: string;
  sourceKey?: string | null;
  externalEventId?: string;
  status?: "queued" | "error";
  processingError?: string | null;
};

export async function enqueueMarketplaceActivity(input: MarketplaceQueueInput) {
  const db = supabaseAdmin();
  const externalEventId = input.externalEventId || marketplaceEventId(input.marketplace, input.payload);
  const status = input.status || "queued";
  const insert = await db.from("marketplace_activities").insert({
    marketplace: input.marketplace,
    event_type: input.eventType,
    external_event_id: externalEventId,
    order_id: input.orderId || null,
    description: input.description,
    status,
    source_key: input.sourceKey || null,
    raw_payload: input.payload,
    processing_error: input.processingError || null,
    next_attempt_at: new Date().toISOString(),
    processed_at: status === "error" ? new Date().toISOString() : null
  }).select("id,status").single();

  if (!insert.error && insert.data) {
    await appendActivityHistory(String(insert.data.id), "received", status === "error" ? "error" : "success", {
      externalEventId,
      eventType: input.eventType,
      sourceKey: input.sourceKey || null
    });
    return { id: String(insert.data.id), duplicated: false, status };
  }

  if (!insert.error || !/duplicate|unique/i.test(insert.error.message)) {
    throw new Error(insert.error?.message || "Falha ao registrar atividade do marketplace.");
  }

  const existing = await db.from("marketplace_activities")
    .select("id,status")
    .eq("marketplace", input.marketplace)
    .eq("external_event_id", externalEventId)
    .maybeSingle()
    .throwOnError();
  if (!existing.data) throw new Error("Evento duplicado nao localizado apos o conflito.");

  if (["error", "retry"].includes(String(existing.data.status)) && status === "queued") {
    await db.from("marketplace_activities").update({
      status: "queued",
      processing_error: null,
      next_attempt_at: new Date().toISOString(),
      processed_at: null
    }).eq("id", existing.data.id).throwOnError();
  }
  await appendActivityHistory(String(existing.data.id), "redelivery", "success", { externalEventId });
  return { id: String(existing.data.id), duplicated: true, status: String(existing.data.status) };
}

export async function completeQueuedActivity(
  activityId: string,
  description: string,
  details: Record<string, unknown> = {}
) {
  await supabaseAdmin().from("marketplace_activities").update({
    status: "processed",
    description,
    processing_error: null,
    processed_at: new Date().toISOString(),
    locked_at: null
  }).eq("id", activityId).throwOnError();
  await appendActivityHistory(activityId, "completed", "success", details);
}

export async function retryQueuedActivity(activity: Record<string, any>, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = Number(activity.attempt_count || 1);
  const exhausted = attempts >= 5;
  const retryMinutes = Math.min(30, Math.max(1, 2 ** Math.max(0, attempts - 1)));
  await supabaseAdmin().from("marketplace_activities").update({
    status: exhausted ? "error" : "retry",
    processing_error: message,
    processed_at: exhausted ? new Date().toISOString() : null,
    next_attempt_at: new Date(Date.now() + retryMinutes * 60_000).toISOString(),
    locked_at: null
  }).eq("id", activity.id).throwOnError();
  await appendActivityHistory(String(activity.id), "processing", exhausted ? "error" : "retry", {
    error: message,
    attempt: attempts,
    retryMinutes: exhausted ? null : retryMinutes
  });
}

export async function appendActivityHistory(
  activityId: string,
  stage: string,
  status: string,
  details: Record<string, unknown> = {}
) {
  const result = await supabaseAdmin().from("marketplace_activity_history").insert({
    activity_id: activityId,
    stage,
    status,
    details
  });
  if (result.error) console.error("[marketplace_activity_history]", result.error);
}

export function marketplaceEventId(marketplace: Marketplace, payload: Record<string, any>) {
  const explicit = marketplace === "shopee"
    ? payload.msg_id || payload.request_id || payload.event_id
    : payload._id || payload.id;
  if (explicit) return String(explicit);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

