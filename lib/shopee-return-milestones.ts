type Row = Record<string, any>;
export type ReturnMilestone = { kind: "request_registered" | "buyer_shipping_pending" | "buyer_posted" | "finalized"; at: string; source: string; field: string; value: string };

// Proven payload shape: code 29, data.updated_values[].update_time (Unix seconds).
// Never use the envelope timestamp, received_at or processing time as occurrence.
export function shopeeReturnPushMilestones(payload: Row): ReturnMilestone[] {
  const p = payload.notification || payload;
  if (Number(p.code) !== 29 || !p.data?.return_sn || !Array.isArray(p.data.updated_values)) return [];
  return p.data.updated_values.flatMap((change: Row) => {
    const seconds = Number(change.update_time);
    const date = new Date(seconds * 1000);
    const at = Number.isInteger(seconds) && seconds > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null;
    if (!at) return [];
    const field = change.update_field, value = change.new_value;
    let kind: ReturnMilestone["kind"] | null = null;
    if (field === "return_status" && !change.old_value && ["REQUESTED", "PROCESSING"].includes(value)) kind = "request_registered";
    else if (field === "return_status" && ["CLOSED", "CANCELLED"].includes(value)) kind = "finalized";
    else if (field === "logistics_status" && ["LOGISTICS_PENDING_ARRANGE", "LOGISTICS_READY", "LOGISTICS_REQUEST_CREATED"].includes(value)) kind = "buyer_shipping_pending";
    else if (field === "logistics_status" && value === "LOGISTICS_PICKUP_DONE") kind = "buyer_posted";
    return kind ? [{ kind, at, source: "shopee:push29", field, value }] : [];
  });
}
