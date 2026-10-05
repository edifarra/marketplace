export function caseDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informado";
  return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
export function caseMoney(value: number | null | undefined) {
  return value == null ? "Não informado" : Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
export function caseImage(product: any) {
  const cover = [...(product?.product_images || [])].sort((a, b) => a.position - b.position)[0];
  const url = cover?.cloudinary_url || cover?.url || "";
  return url.startsWith("/uploads/") || /^https:\/\/res\.cloudinary\.com\//.test(url) ? url : "";
}
export function reputationLabel(row: any) {
  return row.marketplace !== "shopee" && row.reputation_impact === "affected" ? "Afeta reputação" : row.marketplace !== "shopee" && row.reputation_impact === "not_affected" ? "Não afeta reputação" : "Reputação: Não informado";
}
export function caseStatusLabel(row: any) {
  const status = row.reverse_logistics?.status || row.status;
  const labels: Record<string, string> = {
    awaiting_buyer_shipping: "Aguardando postagem pelo comprador", waiting_for_buyer_shipping: "Aguardando postagem pelo comprador",
    ready_to_ship: "Aguardando postagem pelo comprador", in_transit: "Devolução em transporte", shipped: "Devolução postada",
    delivered: "Devolução entregue", awaiting_auto_close: "Aguardando encerramento automático"
  };
  return labels[status] || status || "Estado não informado";
}
export function deadlineLabel(d: any) {
  const owners: Record<string, string> = { buyer: "comprador", seller: "vendedor", marketplace: "marketplace", unknown: "responsável não informado" };
  const purposes: Record<string, string> = { buyer_return_shipping: "Postagem da devolução", seller_response: "Resposta", seller_evidence: "Evidência", seller_validation: "Validação", logistics: "Logística", auto_close: "Encerramento automático", unknown: "Finalidade não informada" };
  const purpose = purposes[d.purpose] || (d.purpose.startsWith("action:") ? `Ação ${d.purpose.slice(7)}` : "Finalidade não informada");
  return `${purpose} · Prazo do ${owners[d.responsible] || owners.unknown}: ${d.precision === "date" ? `${d.value} (sem horário informado)` : caseDate(d.value)}`;
}
