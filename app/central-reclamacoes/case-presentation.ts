type Row = Record<string, any>;
export type DisplayField = [string, string];
const labels: Record<string, string> = {
  FUNCTIONAL_DMG: "Produto com defeito de funcionamento",
  LOGISTICS_NOT_START: "Logística não iniciada", LOGISTICS_READY: "Pronto para envio",
  LOGISTICS_REQUEST_CREATED: "Coleta solicitada", LOGISTICS_PICKUP_PENDING: "Aguardando coleta",
  LOGISTICS_PICKUP_RETRY: "Nova tentativa de coleta", LOGISTICS_PICKUP_DONE: "Pacote coletado",
  LOGISTICS_PICKUP_FAILED: "Falha na coleta", LOGISTICS_PARCEL_RECEIVED: "Recebido pela transportadora",
  LOGISTICS_TRANSPORTING: "Em transporte", LOGISTICS_DELIVERING: "Saiu para entrega",
  LOGISTICS_DELIVERY_DONE: "Entregue", LOGISTICS_DELIVERY_FAILED: "Falha na entrega",
  REQUESTED: "Solicitado", PROCESSING: "Em processamento", ACCEPTED: "Aceito",
  JUDGING: "Em análise", SELLER_DISPUTE: "Em disputa pelo vendedor", CLOSED: "Encerrado", CANCELLED: "Cancelado",
  opened: "Aberto", open: "Aberto", closed: "Encerrado", reopened: "Reaberto",
  awaiting_buyer_shipping: "Aguardando postagem pelo comprador", waiting_for_buyer_shipping: "Aguardando postagem pelo comprador",
  ready_to_ship: "Aguardando postagem pelo comprador", in_transit: "Em transporte", shipped: "Postado", delivered: "Entregue",
  awaiting_auto_close: "Aguardando encerramento automático", seller_validation: "Validação pelo vendedor",
  NOT_NEEDED: "Não necessário", buyer: "Comprador", seller: "Vendedor", marketplace: "Marketplace",
  state_observed: "Situação atualizada", repentant_buyer: "O comprador se arrependeu",
  refund: "Reembolso", return_product: "Devolução do produto"
};
export function presentValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return !text || ["unknown", "null", "undefined", "Não informado"].includes(text) ? null : text;
}
// Unknown machine states stay persisted, but are omitted rather than guessed.
export function humanLabel(value: unknown): string | null {
  const text = presentValue(value);
  if (!text) return null;
  return labels[text] || (/[_]|^[A-Z\d-]+$/.test(text) ? null : text);
}
export function displayFields(fields: [string, unknown][]): DisplayField[] {
  return fields.flatMap(([label, value]) => { const text = presentValue(value); return text == null ? [] : [[label, text] as DisplayField]; });
}
export function returnFields(row: Row): DisplayField[] {
  const logistics = row.reverse_logistics || {};
  return displayFields([
    ["ID da devolução", logistics.return_id || (row.case_type === "return" ? row.external_case_id : null)],
    ["Nome logístico da devolução", logistics.contact_name],
    ["Logística reversa", humanLabel(logistics.status)],
    ["Código de retorno", logistics.tracking]
  ]);
}
export function buyerFields(row: Row): DisplayField[] {
  const buyer = row.buyer_data || {};
  const address = buyer.fiscal_address;
  return displayFields([
    ["Nome público", buyer.display_name || row.buyer_name], ["Apelido", buyer.nickname], ["Razão social", buyer.legal_name],
    ["Documento", buyer.document_number],
    ["Endereço fiscal", address ? [address.street_name,address.street_number,address.neighborhood,address.city_name,address.state?.name].filter(Boolean).join(" · ") : null],
    ["CEP", address?.zip_code], ["Complemento fiscal", address?.comment], ["País", address?.country_id],
    ["Tipo cliente", buyer.customer_type === "BU" ? "Pessoa jurídica" : buyer.customer_type === "CO" ? "Pessoa física" : null],
    ["Situação fiscal", humanLabel(buyer.taxpayer_type)]
  ]);
}
export function timelineFields(state: Row): DisplayField[] {
  return displayFields([["Situação", humanLabel(state.status)], ["Etapa", humanLabel(state.stage)],
    ["Responsável", humanLabel(state.responsible)], ["Logística reversa", humanLabel(state.logistics_status)],
    ["Resolução", humanLabel(typeof state.resolution === "string" ? state.resolution : state.resolution?.reason)],
    ["ID da devolução", state.return_id]]);
}
