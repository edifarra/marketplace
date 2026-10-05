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
  const proof = d.seller_proof || {};
  const deadlineFields: Record<string, [string, string]> = shopee ? {
    return_ship_due_date: ["buyer_return_shipping", "buyer"], return_seller_due_date: ["seller_response", "seller"],
    seller_evidence_deadline: ["seller_evidence", "seller"], due_date: ["unknown", "unknown"]
  } : { due_date: ["unknown", "unknown"] };
  for (const [key, [purpose, responsible]] of Object.entries(deadlineFields)) {
    const value = d[key] ?? proof[key];
    if (value == null || value === 0 || value === "") continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
    deadlines.push({ purpose, official_field: key, responsible,
      value: dateOnly ? String(value) : officialDate(value), raw_value: String(value),
      precision: dateOnly ? "date" : officialDate(value) ? "timestamp" : "unknown",
      timezone: dateOnly ? null : officialDate(value) ? "UTC" : null, source, validity: "observed" });
  }
  const seller = Array.isArray(d.players) ? d.players.find((v: Row) => v.role === "respondent" && v.type === "seller") : null;
  const actions = !shopee && Array.isArray(seller?.available_actions) ? seller.available_actions.map((a: Row) => ({
    code: text(a.action), mandatory: typeof a.mandatory === "boolean" ? a.mandatory : null,
    deadline: officialDate(a.due_date), deadline_raw: text(a.due_date), parameters: {}, observed_at: observed, source
  })).filter((a: Row) => a.code) : [];
  // Preserve unknown follow-up codes without inventing capabilities or their responsibility.
  if (shopee && Array.isArray(d.follow_up_action_list)) for (const action of d.follow_up_action_list) {
    const code = typeof action === "string" ? action : text(action?.action || action?.code || action?.action_type);
    if (!code) continue;
    actions.push({ code, mandatory: typeof action === "object" && action.responsible === "seller" && typeof action.mandatory === "boolean" ? action.mandatory : null,
      deadline: typeof action === "object" && action.responsible === "seller" ? officialDate(action.due_date) : null,
      parameters: { responsible: typeof action === "object" ? actor(action.responsible) : "unknown" }, observed_at: observed, source });
  }
  const required = actions.some((a: Row) => a.mandatory === true) || (shopee && (
    deadlines.some(d => d.responsible === "seller" && d.value) || (d.seller_proof_status || proof.seller_proof_status) === "PENDING"));
  const reverse = d.reverse_logistics || d.return_logistics || {};
  const relatedReturn = Array.isArray(d.related_entities) ? d.related_entities.find((entity: any) => entity === "return" || entity?.type === "return") : null;
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
    related_claim_id: text(shopee ? d.claim_id : id), buyer_name: text(d.buyer_name),
    validation_type: text(d.validation_type), seller_proof_status: text(d.seller_proof_status || proof.seller_proof_status),
    negotiation_status: text(d.negotiation_status),
    reverse_logistics: { return_id: text(shopee ? id : reverse.return_id || d.return_id || relatedReturn?.id),
      entity_created: shopee || Boolean(relatedReturn) || reverse.entity_created === true ? true : null,
      status: text(reverse.status || d.logistics_status), modality: text(reverse.modality),
      tracking: text(reverse.tracking || reverse.tracking_number || d.reverse_tracking_number || (shopee ? d.tracking_number : null)),
      carrier: text(reverse.carrier || reverse.carrier_name || d.reverse_carrier),
      contact_name: text(reverse.contact_name || reverse.sender?.name || reverse.receiver?.name || d.reverse_logistics_contact_name || d.return_contact_name),
      point: text(reverse.point || reverse.agency), address: null },
    enrichment: { state: detail ? "partial" : "incomplete", obtained_at: detail ? observed : null, source, error: null }
  };
  snapshot.capabilities_known = shopee ? Array.isArray(d.follow_up_action_list) : Array.isArray(seller?.available_actions);
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
    resolution: snapshot.resolution ?? null, return_id: snapshot.reverse_logistics?.return_id ?? null,
    return_entity_created: snapshot.reverse_logistics?.entity_created ?? null };
}
export function safeConversation(candidates: Row[], marketplace: string, accountId: string, orderId: string | null) {
  if (!orderId) return null;
  const matches = candidates.filter(c => c.marketplace === marketplace && c.marketplace_account_id === accountId
    && c.order_id === orderId && ["chat", "post_sale"].includes(c.conversation_type));
  return matches.length === 1 ? matches[0].id : null;
}
