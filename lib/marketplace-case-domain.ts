type Row = Record<string, any>;
export type CaseObservation = {
  marketplace: string; marketplace_account_id: string; case_type: string; external_case_id: string;
  source: string; source_key: string; observed_at: string; official_at: string | null; order_at: string;
  snapshot: Row; deadlines: Row[]; actions: Row[]; evidence: Row[];
  identity_only?: boolean;
};
export function caseIdentity(o: CaseObservation) {
  return [o.marketplace, o.marketplace_account_id, o.case_type, o.external_case_id].join(":");
}
export function officialDate(value: unknown): string | null {
  if (value == null || value === "" || value === 0) return null;
  const numeric = typeof value === "number" ? value : /^\d{10,13}$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric == null ? String(value) : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const text = (v: any) => v == null || v === "" ? null : String(v);
const number = (v: any) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const actor = (v: any) => ["buyer", "seller", "marketplace"].includes(v) ? v : "unknown";
export function caseReference(marketplace: string, payload: Row) {
  const p = payload.notification || payload;
  if (marketplace === "shopee") {
    return Number(p.code) === 29 ? text(p.data?.return_sn) : null;
  }
  if (String(p.topic || p.type) !== "post_purchase") return null;
  return text(p.claim_id || p.data?.claim_id || String(p.resource || "").match(/\/claims\/(\d+)(?:\/|$|\?)/)?.[1]);
}

// Only the official case detail or return push is mapped. Never an order's shipping/address/messages.
export function normalizeCase(activity: Row, accountId: string, detail?: Row): CaseObservation | null {
  const p = activity.raw_payload?.notification || activity.raw_payload || {};
  const id = caseReference(activity.marketplace, p);
  if (!id) return null;
  const shopee = activity.marketplace === "shopee";
  const d = detail || (shopee ? p.data || {} : p.claim || p.data?.claim || {});
  const source = detail ? (shopee ? "shopee:return_detail" : "ml:claim_detail") : "persisted_event";
  const observed = detail ? new Date().toISOString() : officialDate(activity.received_at) || new Date().toISOString();
  const official = officialDate(shopee ? d.update_time : d.last_updated || d.date_last_updated);
  const deadlines: Row[] = [];
  for (const key of shopee ? ["return_ship_due_date", "due_date"] : ["due_date"]) {
    if (d[key] == null || d[key] === 0 || d[key] === "") continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(d[key]));
    deadlines.push({ purpose: key === "return_ship_due_date" ? "buyer_return_shipping" : "unknown",
      official_field: key, responsible: key === "return_ship_due_date" ? "buyer" : "unknown",
      value: dateOnly ? String(d[key]) : officialDate(d[key]), raw_value: String(d[key]),
      precision: dateOnly ? "date" : officialDate(d[key]) ? "timestamp" : "unknown",
      timezone: dateOnly ? null : officialDate(d[key]) ? "UTC" : null, source, validity: "observed" });
  }
  const seller = Array.isArray(d.players) ? d.players.find((v: Row) => v.role === "respondent" && v.type === "seller") : null;
  const actions = !shopee && Array.isArray(seller?.available_actions) ? seller.available_actions.map((a: Row) => ({
    code: text(a.action), mandatory: typeof a.mandatory === "boolean" ? a.mandatory : null,
    deadline: officialDate(a.due_date), deadline_raw: text(a.due_date), parameters: {}, observed_at: observed, source
  })).filter((a: Row) => a.code) : [];
  const required = actions.some((a: Row) => a.mandatory === true);
  const snapshot: Row = {
    order_id: text(shopee ? d.order_sn || p.data?.order_sn : d.resource === "order" ? d.resource_id : null),
    status: text(shopee ? d.return_status || d.status : d.status), stage: text(d.stage),
    responsible: actor(d.responsible), needs_action: required ? true : null,
    resolution: d.resolution ? { reason: text(d.resolution.reason), closed_by: text(d.resolution.closed_by),
      date_created: officialDate(d.resolution.date_created) } : null,
    reason_code: text(d.reason_id || d.reason_code || d.reason), reason: text(d.reason_text),
    buyer_description: text(shopee ? d.text_reason : d.description), affected_quantity: number(d.quantity),
    refund_amount: number(d.refund_amount), currency: text(d.currency),
    reputation_impact: "unknown",
    reverse_logistics: { status: text(d.logistics_status), modality: null, tracking: null, address: null },
    enrichment: { state: detail ? "partial" : "incomplete", obtained_at: detail ? observed : null, source, error: null }
  };
  snapshot.capabilities_known = !shopee && Array.isArray(seller?.available_actions);
  const evidence: Row[] = [];
  // These are references from a return detail, not attachments copied from Chat.
  if (shopee && detail && Array.isArray(d.image)) {
    for (const reference of d.image) {
      if (typeof reference === "string" && reference && !/access_token|refresh_token/i.test(reference)) {
        evidence.push({ media_type: "image", reference, metadata: { source, observed_at: observed } });
      }
    }
  }
  // No automatic inference from open/closed or from Shopee reputation.
  if (!shopee && ["affected", "not_affected"].includes(d.affects_reputation)) snapshot.reputation_impact = d.affects_reputation;
  if (!shopee && Array.isArray(seller?.available_actions) && actions.every((a: Row) => a.mandatory === false)) snapshot.needs_action = false;
  for (const a of actions) {
    if (a.deadline) deadlines.push({ purpose: `action:${a.code}`, official_field: "players.available_actions.due_date",
      responsible: "seller", value: a.deadline, raw_value: a.deadline_raw, precision: "timestamp", timezone: "UTC", source, validity: "observed" });
  }
  if (required) snapshot.responsible = "seller";
  const key = `${activity.id}:${detail ? "detail" : "local"}`;
  return { marketplace: activity.marketplace, marketplace_account_id: accountId,
    case_type: shopee ? "return" : "claim", external_case_id: id, source, source_key: key,
    observed_at: observed, official_at: official, order_at: officialDate(activity.received_at) || observed,
    snapshot, deadlines, actions, evidence };
}
export function transitionState(snapshot: Row) {
  return { status: snapshot.status ?? null, stage: snapshot.stage ?? null,
    responsible: snapshot.responsible || "unknown", logistics_status: snapshot.reverse_logistics?.status ?? null,
    resolution: snapshot.resolution ?? null };
}
export function safeConversation(candidates: Row[], marketplace: string, accountId: string, orderId: string | null) {
  if (!orderId) return null;
  const matches = candidates.filter(c => c.marketplace === marketplace && c.marketplace_account_id === accountId
    && c.order_id === orderId && ["chat", "post_sale"].includes(c.conversation_type));
  return matches.length === 1 ? matches[0].id : null;
}
