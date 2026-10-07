export type ClaimRow = Record<string, any>;
export type ClaimAction = "refund" | "allow_partial_refund" | "allow_return" | "send_message_to_complainant";
export const CLAIM_ACTION_LABELS: Record<ClaimAction, string> = {
  refund: "Oferecer Reembolso Total", allow_partial_refund: "Oferecer Reembolso Parcial",
  allow_return: "Oferecer devolução do produto", send_message_to_complainant: "Enviar mensagem"
};
export const stableClaimValue=(value:unknown)=>JSON.stringify(value,(_key,v)=>v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
export class ClaimError extends Error {
  constructor(message: string, public readonly status = 409, public readonly uncertain = false) { super(message); }
}
export function claimSeller(claim: ClaimRow, sellerId: string) {
  return (claim.players || []).find((p: ClaimRow) => p.role === "respondent" && p.type === "seller" && String(p.user_id) === sellerId);
}
export function currentClaimActions(claim: ClaimRow, sellerId: string) {
  return claim.status === "opened" ? claimSeller(claim, sellerId)?.available_actions || [] : [];
}
export function claimBuyerId(claim: ClaimRow) {
  return String((claim.players || []).find((p: ClaimRow) => p.role === "complainant" && p.type === "buyer")?.user_id || "");
}
export function validateClaimAction(claim: ClaimRow, expected: ClaimRow, action: string, now = Date.now()) {
  if (!Object.hasOwn(CLAIM_ACTION_LABELS,action)) throw new ClaimError("Esta ação não está habilitada na Central.", 400);
  if (String(claim.id) !== expected.claimId || claim.resource !== "order" || String(claim.resource_id) !== expected.orderId
    || claimBuyerId(claim) !== expected.buyerId || !claimSeller(claim, expected.sellerId)) throw new ClaimError("A conta, reclamação, pedido ou comprador mudou. Reabra o caso.");
  if (claim.status !== "opened") throw new ClaimError("A reclamação já está encerrada.");
  const capability = currentClaimActions(claim, expected.sellerId).find((a: ClaimRow) => a.action === action);
  if (!capability) throw new ClaimError("Esta ação não está mais disponível no Mercado Livre.");
  if (capability.due_date && Date.parse(capability.due_date) <= now) throw new ClaimError("O prazo desta ação expirou. Atualize o caso.");
  return capability;
}
export function validPartialOffers(payload: ClaimRow) {
  const restrictions = Array.isArray(payload.restrictions) ? payload.restrictions : [];
  return (Array.isArray(payload.available_offers) ? payload.available_offers : []).filter((o: ClaimRow) =>
    Number.isFinite(o.amount) && o.amount > 0 && Number.isFinite(o.percentage) && o.percentage > 0 && o.percentage < 100
    && restrictions.every((r: ClaimRow) => r.type !== "minimum" || o.percentage >= Number(r.percentage)));
}
export function validatePartialOffer(payload: ClaimRow, selected: ClaimRow) {
  if (!selected || !Number.isFinite(selected.percentage)) throw new ClaimError("Selecione explicitamente uma oferta válida.", 400);
  const offer = validPartialOffers(payload).find((o: ClaimRow) => o.percentage === selected.percentage && o.amount === selected.amount);
  if (!offer || payload.currency_id !== selected.currency) throw new ClaimError("A oferta mudou ou expirou. Consulte as opções novamente.");
  return offer;
}
export function claimEndpoint(claimId: string, action: ClaimAction) {
  const root = `/post-purchase/v1/claims/${encodeURIComponent(claimId)}`;
  return action === "send_message_to_complainant" ? `${root}/actions/send-message` : `${root}/expected-resolutions/${({refund:"refund",allow_partial_refund:"partial-refund",allow_return:"allow-return"} as const)[action]}`;
}
export function claimPayload(action: ClaimAction, parameters: ClaimRow) {
  if (action === "allow_partial_refund") return { percentage: parameters.offer.percentage };
  if (action === "send_message_to_complainant") {
    const text = typeof parameters.message === "string" ? parameters.message.trim() : "";
    if (!text || text.length > 4000) throw new ClaimError("Informe uma mensagem de até 4.000 caracteres.", 400);
    return { receiver_role: "complainant", message: text };
  }
  return undefined;
}
