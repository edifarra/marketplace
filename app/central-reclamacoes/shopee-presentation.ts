type Row = Record<string, any>;
const labels = ["Comprador solicitou Devolução/Reembolso", "Pendente comprador postar devolução", "Em validação pelo vendedor", "Solicitação finalizada"];
type Progress = "complete" | "current" | "pending" | "unknown";
function stage(state: Row): number | null {
  if (["CLOSED", "CANCELLED"].includes(state.status)) return 3;
  // Generic PROCESSING/ACCEPTED/JUDGING do not prove posting or seller validation.
  if (state.stage === "seller_validation") return 2;
  if (["awaiting_buyer_shipping", "waiting_for_buyer_shipping", "ready_to_ship"].includes(state.stage) ||
      (state.buyer_shipping_required && ["LOGISTICS_NOT_START", "LOGISTICS_READY", "LOGISTICS_REQUEST_CREATED", "LOGISTICS_PICKUP_PENDING"].includes(state.logistics_status))) return 1;
  if (state.status === "REQUESTED") return 0;
  return null;
}
export function shopeeTimeline(row: Row, events: Row[], deadlines: Row[] = []) {
  // A default logistics state alone can also appear on refund-only requests.
  const buyerShipping = deadlines.some(d => d.purpose === "buyer_return_shipping" && d.responsible === "buyer" && d.value);
  const current = stage({ ...row, logistics_status: row.reverse_logistics?.status, buyer_shipping_required: buyerShipping });
  const known = new Set<number>();
  const dates = new Map<number, string>();
  for (const event of events) {
    const index = stage(event.state || {});
    if (index == null) continue;
    known.add(index);
    // Local observation time is never presented as the official transition date.
    if (event.official_at && Number.isFinite(Date.parse(event.official_at)) &&
        (!dates.has(index) || Date.parse(event.official_at) < Date.parse(dates.get(index)!))) dates.set(index, event.official_at);
  }
  return { ambiguous: current == null, steps: labels.map((label, index) => {
    let progress: Progress = "pending";
    if (index === current) progress = "current";
    else if ((index === 0 && (current != null || known.has(0))) || (known.has(index) && current != null && index < current)) progress = "complete";
    else if (current == null || (current > index)) progress = "unknown";
    return { label, progress, date: dates.get(index) || null };
  }) };
}
export function evidenceUrl(reference: unknown): string | null {
  if (typeof reference !== "string" || /access_token|refresh_token/i.test(reference)) return null;
  try {
    const url = new URL(reference);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
