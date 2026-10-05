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
export function deadlineLabel(d: any) {
  return `${d.purpose === "buyer_return_shipping" ? "Envio da devolução pelo comprador" : `Ação ${d.purpose.slice(7)}`} — ${d.precision === "date" ? `${d.value} (sem horário informado)` : caseDate(d.value)}`;
}
