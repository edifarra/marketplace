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
  return enqueueMarketplaceActivityWithClient(supabaseAdmin(), input);
}

export async function enqueueMarketplaceActivityWithClient(
  db: ReturnType<typeof supabaseAdmin>,
  input: MarketplaceQueueInput,
  recordHistory: typeof appendActivityHistory = appendActivityHistory
) {
  const externalEventId = input.externalEventId || marketplaceEventId(input.marketplace, input.payload);
  const status = input.status || "queued";
  const now = new Date().toISOString();
  const result = await db.rpc("enqueue_marketplace_activity_idempotently", {
    p_marketplace: input.marketplace,
    p_event_type: input.eventType,
    p_external_event_id: externalEventId,
    p_order_id: input.orderId || null,
    p_description: input.description,
    p_status: status,
    p_source_key: input.sourceKey || null,
    p_raw_payload: input.payload,
    p_processing_error: input.processingError || null,
    p_next_attempt_at: now,
    p_processed_at: status === "error" ? now : null
  }).single().throwOnError();
  const activity = result.data as { id: string; status: string; duplicated: boolean } | null;

  if (!activity) throw new Error("Falha ao registrar atividade do marketplace.");
  if (!activity.duplicated) {
    await recordHistory(String(activity.id), "received", status === "error" ? "error" : "success", {
      externalEventId,
      eventType: input.eventType,
      sourceKey: input.sourceKey || null
    });
    return { id: String(activity.id), duplicated: false, status };
  }

  await recordHistory(String(activity.id), "redelivery", "success", { externalEventId });
  return { id: String(activity.id), duplicated: true, status: String(activity.status) };
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
