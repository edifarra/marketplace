import { createHash } from "node:crypto";
import { officialDate } from "./marketplace-case-domain";
import { stableClaimValue } from "./marketplace-claim-domain";
type Row = Record<string, any>;
const hash = (v: unknown) => createHash("sha256").update(stableClaimValue(v)).digest("hex");
export function officialClaimMessages(messages: Row[], claimId: string) {
  return messages.flatMap(m => {
    const at = officialDate(m.message_date || m.date_created);
    if (!at) return [];
    const key = String(m.hash || m.id || hash([claimId,m.sender_role,m.receiver_role,at,m.message,m.attachments || []]));
    return [{ key, direction: m.sender_role === "respondent" ? "outgoing" : m.sender_role === "complainant" ? "incoming" : "system",
      text: String(m.message || ""), sender_role: m.sender_role, at, raw: {
        hash: m.hash || null, sender_role: m.sender_role, receiver_role: m.receiver_role, stage: m.stage,
        message_moderation: m.message_moderation || null, official_status: m.status || null,
        attachments: (m.attachments || []).map((a: Row) => ({ filename:a.filename,original_filename:a.original_filename,size:a.size,type:a.type,date_created:a.date_created }))
      } }];
  });
}
const labels: Record<string,string> = { open_claim:"Reclamação aberta", refund:"Reembolso total", allow_return:"Devolução oferecida",
  generate_return:"Devolução criada", allow_partial_refund:"Reembolso parcial oferecido", send_message_to_complainant:"Mensagem enviada",
  open_dispute:"Mediação iniciada", close_claim:"Reclamação encerrada" };
export function claimOfficialEvents(claim: Row, extra: Row) {
  const events: Row[] = [];
  const add = (source: string, type: string, actor: string, value: unknown, identity: unknown, state: Row = {}) => {
    const at = officialDate(value); if (!at) return;
    const key = `${source}:${claim.id}:${type}:${hash([identity,actor,at])}`;
    events.push({ key, event_type: labels[type] || type, actor: actor || "unknown", official_at: at, source, state });
  };
  for (const a of extra.actions || []) {
    if (String(a.action_name).startsWith("send_message") && (extra.messages || []).some((m: Row) => m.sender_role === a.player_role && officialDate(m.message_date || m.date_created) === officialDate(a.date_created))) continue;
    add("ml:actions",a.action_name,a.player_role,a.date_created,a.id || [a.action_reason_id,a.claim_stage,a.claim_status]);
  }
  for (const s of extra.statuses || []) {
    if ((extra.actions || []).some((a: Row) => ["open_claim","close_claim","open_dispute"].includes(a.action_name) && officialDate(a.date_created) === officialDate(s.date))) continue;
    add("ml:status",s.status === "opened" ? "Reclamação aberta" : s.status === "closed" ? "Reclamação encerrada" : "Estado atualizado",s.change_by,s.date,s.id || [s.status,s.stage],{stage:s.stage});
  }
  if (!events.some(e => e.event_type === "Reclamação aberta")) add("ml:claim","open_claim","complainant",claim.date_created,claim.id);
  for (const m of officialClaimMessages(extra.messages || [],String(claim.id))) add("ml:message","Mensagem",m.sender_role,m.at,m.key,{message_key:m.key});
  for (const r of extra.resolutions || []) add("ml:resolution",r.status === "pending" ? "Solução proposta" : r.status === "accepted" ? "Solução aceita" : "Solução rejeitada",r.player_role,r.last_updated || r.last_update || r.date_created,r.id || [r.expected_resolution,r.status,r.details || r.detail],{resolution:r.expected_resolution});
  const ret = extra.return || {};
  if (ret.id) for (const shipment of ret.shipments || []) add("ml:return","Logística reversa atualizada","marketplace",shipment.last_updated || shipment.date_created,shipment.shipment_id,{status:shipment.status,return_id:String(ret.id)});
  if (claim.resolution?.date_created) add("ml:claim","Reclamação resolvida",claim.resolution.closed_by,claim.resolution.date_created,claim.resolution.reason,{resolution:claim.resolution.reason});
  return events;
}
export function saleOfficialEvents(sale: Row | null) {
  const payload = sale?.raw_data?.payload || {}; const order = payload.order || {}; const events: Row[] = [];
  const add = (label: string, value: unknown, identity: string) => { const at=officialDate(value); if(at) events.push({id:`sale:${identity}`,event_type:label,official_at:at,state:{},source:"ml:sale"}); };
  add(`Venda #${order.id || sale?.order_id}`,order.date_created,String(order.id || sale?.order_id));
  for(const p of order.payments || []) if(p.date_approved) add("Pagamento aprovado",p.date_approved,`payment:${p.id}`);
  for(const s of payload.shipmentHistory || []) {
    const label=s.substatus === "dropped_off" ? "Produto postado" : s.status === "shipped" && !s.substatus ? "Produto em transporte" : s.status === "delivered" ? "Produto entregue" : null;
    if(label) add(label,s.date,`shipment:${sale?.shipment_id}:${s.status}:${s.substatus || ""}:${s.date}`);
  }
  return events;
}
export function orderedClaimTimeline(events: Row[]) {
  const unique=new Map<string,Row>();
  for(const e of events) if(e.official_at && officialDate(e.official_at)) unique.set(e.transition_key || e.key || e.id,e);
  return [...unique.values()].sort((a,b)=>Date.parse(a.official_at)-Date.parse(b.official_at) || String(a.transition_key || a.key || a.id).localeCompare(String(b.transition_key || b.key || b.id)));
}
