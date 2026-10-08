import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";
import { getMercadoLivreAccountById } from "./mercado-livre";
import { enrichMercadoLivreClaim, enrichShopeeReturn } from "./marketplace-case-enrichment";
import { normalizeCase } from "./marketplace-case-domain";
import { persistCaseObservation } from "./marketplace-cases";
type Row = Record<string, any>;
export const CASE_RECONCILIATION_MS = 60 * 60_000;
export function reconciliableCase(row: Row) {
  return row.marketplace === "mercado_livre" ? row.case_type === "claim" && ["open", "opened", "reopened"].includes(row.status)
    : row.marketplace === "shopee" && row.case_type === "return" && ["REQUESTED", "PROCESSING", "ACCEPTED", "JUDGING", "SELLER_DISPUTE"].includes(row.status);
}
export async function scheduleCaseReconciliation(db = supabaseAdmin(), maximumBatches = Infinity) {
  const owner = randomUUID();
  let checked = 0, queued = 0;
  // Read-only marketplace probes use durable case leases. Only changes/errors need queue jobs.
  for (let batch = 0; batch < maximumBatches; batch++) {
    const claimed = await db.rpc("claim_marketplace_case_checks", { p_owner: owner, p_limit: 20 }).throwOnError();
    const cases: Row[] = claimed.data || [];
    if (!cases.length) return { checked, queued, drained: true };
    // Five simultaneous GET bundles, at most twenty leased identities per batch.
    for (let offset = 0; offset < cases.length; offset += 5) {
      const results = await Promise.all(cases.slice(offset, offset + 5).map(async row => {
        try {
          const detail = row.marketplace === "mercado_livre"
            ? await enrichMercadoLivreClaim(row.external_case_id, row.account)
            : await enrichShopeeReturn(row.external_case_id, row.account);
          const payload = row.marketplace === "mercado_livre" ? { topic: "post_purchase", claim_id: row.external_case_id }
            : { code: 29, data: { return_sn: row.external_case_id, order_sn: row.order_id } };
          const observation = normalizeCase({ id: `check:${owner}:${row.id}`, marketplace: row.marketplace,
            received_at: new Date().toISOString(), raw_payload: payload }, row.marketplace_account_id, detail);
          if (!observation) throw new Error("Detalhe incompatível.");
          return { case_id: row.id, observation };
        } catch { return { case_id: row.id, error: "case_check_failed" }; }
      }));
      const finished = await db.rpc("finish_marketplace_case_checks", { p_owner: owner, p_results: results }).throwOnError();
      checked += Number(finished.data?.checked || 0); queued += Number(finished.data?.queued || 0);
    }
  }
  return { checked, queued, drained: false };
}
export async function withCaseRefreshLease<T>(caseId: string, run: () => Promise<T>, db = supabaseAdmin()) {
  const owner = randomUUID();
  const acquired = await db.rpc("begin_marketplace_case_refresh", { p_case_id: caseId, p_owner: owner }).throwOnError();
  if (!acquired.data) throw new Error("Caso já está sendo atualizado; preservado para retry pela fila.");
  let success: boolean | null = false;
  try { const result = await run(); success = result && typeof result === "object" && "skipped" in result ? null : true; return result; }
  finally { await db.rpc("finish_marketplace_case_refresh", { p_case_id: caseId, p_owner: owner, p_success: success }).throwOnError(); }
}
export async function processCaseReconciliation(activity: Row, db = supabaseAdmin()) {
  if (activity.raw_payload?.case_observation) {
    const observation = activity.raw_payload.case_observation;
    if (observation.marketplace !== activity.marketplace || observation.marketplace_account_id !== activity.raw_payload.account_id) throw new Error("Identidade da observação divergente.");
    return withCaseRefreshLease(activity.raw_payload.case_reconcile_id, async () => {
      const result = await db.from("marketplace_cases").select("marketplace,marketplace_account_id,external_case_id,case_type").eq("id", activity.raw_payload.case_reconcile_id).single().throwOnError();
      if (result.data.marketplace !== observation.marketplace || result.data.marketplace_account_id !== observation.marketplace_account_id || result.data.external_case_id !== observation.external_case_id || result.data.case_type !== observation.case_type) throw new Error("Identidade do caso divergente.");
      await persistCaseObservation(observation, db);
      return { checked: activity.raw_payload.case_reconcile_id };
    }, db);
  }
  const id = activity.raw_payload?.case_reconcile_id;
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("Identidade da reconciliação inválida.");
  return withCaseRefreshLease(id, async () => {
    const result = await db.from("marketplace_cases").select("id,marketplace,marketplace_account_id,case_type,external_case_id,order_id,status").eq("id", id).maybeSingle().throwOnError();
    const row = result.data;
    if (!row || !reconciliableCase(row)) return { skipped: "terminal_or_unknown" };
    if (row.marketplace !== activity.marketplace) throw new Error("Marketplace da reconciliação diverge do caso.");
    if ((await db.rpc("marketplace_case_has_pending_event", { p_case_id: id }).throwOnError()).data) return { skipped: "pending_webhook" };
    const control = await db.from("marketplace_case_sync_control").select("last_checked_at").eq("case_id", id).single().throwOnError();
    // An event processed after scheduling already supplied the current bundle.
    if (control.data.last_checked_at && Date.parse(control.data.last_checked_at) >= Date.parse(activity.received_at)) return { skipped: "already_refreshed" };
    const account = row.marketplace === "mercado_livre" ? await getMercadoLivreAccountById(row.marketplace_account_id)
      : (await db.from("config_marketplace_accounts").select("*").eq("id", row.marketplace_account_id).eq("marketplace", "shopee").single().throwOnError()).data;
    if (!account?.active) return { skipped: "inactive_account" };
    const detail = row.marketplace === "mercado_livre" ? await enrichMercadoLivreClaim(row.external_case_id, account) : await enrichShopeeReturn(row.external_case_id, account);
    const payload = row.marketplace === "mercado_livre" ? { topic: "post_purchase", claim_id: row.external_case_id }
      : { code: 29, data: { return_sn: row.external_case_id, order_sn: row.order_id } };
    const observation = normalizeCase({ ...activity, received_at: new Date().toISOString(), raw_payload: payload }, row.marketplace_account_id, detail);
    if (!observation) throw new Error("Detalhe incompatível com o caso.");
    await persistCaseObservation(observation, db);
    return { checked: id };
  }, db);
}
