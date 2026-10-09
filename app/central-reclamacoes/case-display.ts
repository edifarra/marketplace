import { humanLabel } from "./case-presentation";
import { productImageUrl } from "@/lib/product-image-source";
export function caseDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informado";
  return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
export function caseMoney(value: number | null | undefined,currency="BRL") {
  return value == null ? "Não informado" : Number(value).toLocaleString("pt-BR", { style: "currency", currency });
}
export function caseImage(product: any) {
  const cover = [...(product?.product_images || [])].sort((a, b) => a.position - b.position)[0];
  const url = productImageUrl(cover);
  return url.startsWith("/uploads/") || /^https:\/\//.test(url) ? url : "";
}
export function reputationLabel(row: any) {
  return row.marketplace === "shopee" ? "" : ({affected:"Afeta sua reputação",not_affected:"Não afeta sua reputação",not_applies:"Não se aplica à reputação"} as Record<string,string>)[row.reputation_impact] || "";
}
export function caseReason(row:any) {
  return ({repentant_buyer:"O comprador se arrependeu"} as Record<string,string>)[row.reason_name] || humanLabel(row.reason) || humanLabel(row.reason_code) || (row.marketplace === "shopee" ? row.reason_code || "" : "");
}
export function caseHeaderRow(initial:any, detail:any) {
  if (!detail) return initial;
  const row = { ...initial, ...detail.row, items: detail.items, deadlines: detail.deadlines };
  const closed = row.marketplace === "mercado_livre" ? row.status === "closed" : ["CLOSED", "CANCELLED"].includes(row.status);
  const ongoing = row.marketplace === "mercado_livre" ? ["open", "opened", "reopened"].includes(row.status) : ["REQUESTED", "PROCESSING", "ACCEPTED", "JUDGING", "SELLER_DISPUTE"].includes(row.status);
  row.group = closed ? "closed" : row.needs_action === true ? "action" : ongoing ? "ongoing" : "unknown";
  row.groupLabel = ({action:"Precisa de ação",ongoing:"Em andamento / aguardando",closed:"Encerrado",unknown:"Desconhecido / incompleto"} as Record<string,string>)[row.group];
  return row;
}
export function claimDescription(row:any) {
  if (row.reason_name === "repentant_buyer" && row.reason)
    return "O comprador disse que chegou em boas condições, mas não quer mais o produto.";
  return row.reason || row.buyer_description || "";
}
export function sellerDeadline(row:any,deadlines:any[]) {
  if(row.status !== "opened")return null;
  return [...deadlines].filter(d=>d.responsible === "seller" && d.precision === "timestamp" && Number.isFinite(Date.parse(d.value)) && d.purpose?.startsWith("action:")
    && (!Array.isArray(row.current_actions) || row.current_actions.some((a:any)=>`action:${a.code}` === d.purpose)))
    .sort((a,b)=>Date.parse(a.value)-Date.parse(b.value))[0]?.value || null;
}
export function caseStatusLabel(row: any) {
  const status = row.reverse_logistics?.status || row.status;
  return humanLabel(status) || humanLabel(row.status) || "Estado não informado";
}
export function deadlineLabel(d: any) {
  const owners: Record<string, string> = { buyer: "comprador", seller: "vendedor", marketplace: "marketplace", unknown: "responsável não informado" };
  const purposes: Record<string, string> = { buyer_return_shipping: "Postagem da devolução", seller_response: "Resposta", seller_evidence: "Evidência", seller_validation: "Validação", logistics: "Logística", auto_close: "Encerramento automático", unknown: "Finalidade não informada" };
  const purpose = purposes[d.purpose] || (d.purpose?.startsWith("action:") ? humanLabel(d.purpose.slice(7)) || "Ação do marketplace" : "Finalidade não informada");
  return `${purpose} · Prazo do ${owners[d.responsible] || owners.unknown}: ${d.precision === "date" ? `${d.value} (sem horário informado)` : caseDate(d.value)}`;
}
