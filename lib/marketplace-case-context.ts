type Row = Record<string, any>;
export type CaseContext = "claim" | "return";
// Persisted return identity or a real reverse tracking number is evidence, a requested solution is not.
export function caseContext(row: Row): CaseContext {
  const logistics = row.reverse_logistics || {};
  return row.case_type === "return" || logistics.entity_created === true || Boolean(logistics.return_id || logistics.tracking) ? "return" : "claim";
}
export function caseClosed(row: Row) {
  return row.marketplace === "mercado_livre" ? row.status === "closed" : ["CLOSED", "CANCELLED"].includes(row.status);
}
export function caseAttention(row: Row) {
  return !caseClosed(row) && row.needs_action === true ? "ACTION_REQUIRED" : "MONITORING";
}
export function globalCaseAlert(row: Row) {
  return caseContext(row) === "claim" && caseAttention(row) === "ACTION_REQUIRED";
}
// NULL and empty JSON values are explicitly handled to avoid SQL three-valued logic gaps.
const present = (field: string) => `and(${field}.not.is.null,${field}.neq."")`;
export const RETURN_CONTEXT_FILTER = `or(case_type.eq.return,reverse_logistics->>entity_created.eq.true,${present("reverse_logistics->>return_id")},${present("reverse_logistics->>tracking")})`;
export const CLAIM_CONTEXT_FILTER = `and(case_type.eq.claim,or(reverse_logistics->>entity_created.is.null,reverse_logistics->>entity_created.neq.true),or(reverse_logistics->>return_id.is.null,reverse_logistics->>return_id.eq.""),or(reverse_logistics->>tracking.is.null,reverse_logistics->>tracking.eq.""))`;
export const ACTIVE_ACTION_FILTER = "and(needs_action.eq.true,or(status.is.null,and(not.and(marketplace.eq.mercado_livre,status.eq.closed),not.and(marketplace.eq.shopee,status.in.(CLOSED,CANCELLED)))))";
