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
  const sellerDue = deadlines.some(d => d.purpose === "seller_response" && d.responsible === "seller" && d.value);
  const validation = row.status === "PROCESSING" && row.validation_type === "seller_validation" && row.reverse_logistics?.status === "LOGISTICS_DELIVERY_DONE" && sellerDue;
  const current = stage({ ...row, stage: row.stage || (validation ? "seller_validation" : null), logistics_status: row.reverse_logistics?.status, buyer_shipping_required: buyerShipping });
  const known = new Set<number>();
  const dates = new Map<number, { at: string; label: string }>();
  for (const event of events) {
    const index = stage(event.state || {});
    if (index == null) continue;
    known.add(index);
    // Old state_observed.official_at came from detail.update_time, not stage occurrence.
  }
  const milestones: Row[] = Array.isArray(row.return_milestones) ? row.return_milestones : [];
  const first = (kind: string) => milestones.filter(m => m.kind === kind && m.source === "shopee:push29" && Number.isFinite(Date.parse(m.at))).sort((a,b) => Date.parse(a.at)-Date.parse(b.at))[0];
  const registered = first("request_registered"), posted = first("buyer_posted"), pending = first("buyer_shipping_pending"), finalized = first("finalized");
  if (row.return_created_at && Number.isFinite(Date.parse(row.return_created_at))) dates.set(0, { at: row.return_created_at, label: "Solicitado em" });
  else if (registered) dates.set(0, { at: registered.at, label: "Notificação da solicitação" });
  if (dates.has(0)) known.add(0);
  if (posted) { known.add(1); dates.set(1, { at: posted.at, label: "Postagem confirmada em" }); }
  else if (pending) dates.set(1, { at: pending.at, label: "Aguardando postagem desde" });
  if (finalized) dates.set(3, { at: finalized.at, label: "Finalizado em" });
  return { ambiguous: current == null, steps: labels.map((label, index) => {
    let progress: Progress = "pending";
    if (index === current) progress = "current";
    else if ((index === 0 && (current != null || known.has(0))) || (index === 1 && posted && current !== 1) || (known.has(index) && current != null && index < current)) progress = "complete";
    else if (current == null || (current > index)) progress = "unknown";
    return { label, progress, date: dates.get(index)?.at || null, dateLabel: dates.get(index)?.label || null };
  }) };
}
export function evidenceUrl(reference: unknown): string | null {
  if (typeof reference !== "string" || /access_token|refresh_token/i.test(reference)) return null;
  try {
    const url = new URL(reference);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
