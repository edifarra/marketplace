import { supabaseAdmin } from "./supabase-admin";
import { appendActivityHistory } from "./marketplace-queue";
import { CaseObservation, caseReference, normalizeCase, transitionState } from "./marketplace-case-domain";

type Row = Record<string, any>;
type CaseDependencies = {
  persist: (o: CaseObservation) => Promise<string>;
  eligible: (activity: Row) => Promise<boolean>;
  enriched: (caseId: string, sourceKey: string) => Promise<boolean>;
  enrich: (id: string) => Promise<Row>;
  failure: (caseId: string, activity: Row) => Promise<void>;
  history: (activityId: string, stage: string, status: string, details: Row) => Promise<void>;
};

export async function persistCaseObservation(o: CaseObservation, db = supabaseAdmin()) {
  const result = await db.rpc("persist_marketplace_case", { p_observation: { ...o, state: transitionState(o.snapshot) } }).throwOnError();
  return String(result.data);
}

// The local path cannot load any marketplace client. Enrichment must be explicitly supplied by the worker.
export async function processCaseEvent(activity: Row, accountId: string, deps: CaseDependencies) {
  const local = normalizeCase(activity, accountId);
  if (!local) return null;
  const caseId = await deps.persist(local);
  await deps.history(String(activity.id), "case_persisted", "success", { caseId, externalCaseId: local.external_case_id });
  if (!await deps.eligible(activity) || await deps.enriched(caseId, `${activity.id}:detail`)) return caseId;
  try {
    const detail = await deps.enrich(local.external_case_id);
    const enriched = normalizeCase(activity, accountId, detail)!;
    await deps.persist(enriched);
    await deps.history(String(activity.id), "case_enriched", "success", { caseId });
    return caseId;
  } catch {
    // Persist only a fixed error code: marketplace exceptions can contain signed URLs or credentials.
    await deps.failure(caseId, activity);
    await deps.history(String(activity.id), "case_enrichment", "retry", { caseId, error: "case_enrichment_failed" });
    throw new Error(`Falha no enriquecimento do Caso ${local.external_case_id}; dados locais preservados para retry.`);
  }
}

export async function processNewCaseEvent(activity: Row, accountId: string, enrich: (id: string) => Promise<Row>) {
  const db = supabaseAdmin();
  return processCaseEvent(activity, accountId, {
    persist: o => persistCaseObservation(o, db),
    eligible: async a => {
      const { data } = await db.from("marketplace_case_rollout").select("enrichment_starts_at").eq("singleton", true).single().throwOnError();
      return Boolean(a.received_at && new Date(a.received_at).getTime() >= new Date(data!.enrichment_starts_at).getTime());
    },
    enriched: async (id, key) => {
      const { data } = await db.from("marketplace_case_observations").select("id").eq("case_id", id).eq("source_key", key).maybeSingle().throwOnError();
      return Boolean(data);
    },
    enrich,
    failure: async (id, a) => {
      // Do not replace enrichment belonging to an already newer event.
      await db.from("marketplace_cases").update({ enrichment: { state: "error", source: "new_event",
        error: "case_enrichment_failed", activity_id: String(a.id), observed_at: new Date().toISOString() } })
        .eq("id", id).lte("snapshot_order_at", a.received_at).throwOnError();
    },
    history: appendActivityHistory
  });
}

export async function processCaseAndOrders(
  processCase: () => Promise<string | null>, orderIds: string[], processOrder: (id: string) => Promise<unknown>
) {
  let caseId: string | null = null, caseError: unknown, orderError: unknown;
  try { caseId = await processCase(); } catch (error) { caseError = error; }
  for (const id of orderIds) {
    try { await processOrder(id); } catch (error) { orderError = error; }
  }
  if (caseError || orderError) throw caseError || orderError;
  return caseId;
}

export function resolveLocalAccount(marketplace: string, payload: Row, accounts: Row[]) {
  const p = payload.notification || payload;
  const external = String(marketplace === "shopee" ? p.shop_id || p.data?.shop_id || "" : p.user_id || "");
  if (!external) return null;
  const matches = accounts.filter(a => a.marketplace === marketplace &&
    (marketplace === "shopee" ? [a.shop_id, a.account_id] : [a.seller_id, a.account_id]).some(id => String(id || "") === external));
  return matches.length === 1 ? String(matches[0].id) : null;
}

// Database reads and the same atomic writer only. Never re-enqueues or processes an activity.
export async function consolidateLocalCases(db = supabaseAdmin()) {
  const { data: accounts } = await db.from("config_marketplace_accounts").select("id,marketplace,seller_id,account_id,shop_id").throwOnError();
  const { data: rollout } = await db.from("marketplace_case_rollout").select("enrichment_starts_at").single().throwOnError();
  let cursor = "", cursorTime = "", scanned = 0, consolidated = 0, unknownAccount = 0;
  for (;;) {
    let query = db.from("marketplace_activities").select("id,marketplace,raw_payload,received_at")
      .lt("received_at", rollout!.enrichment_starts_at).in("event_type", ["post_purchase", "29"])
      .order("received_at").order("id").limit(250);
    if (cursor) query = query.or(`received_at.gt.${cursorTime},and(received_at.eq.${cursorTime},id.gt.${cursor})`);
    const { data } = await query.throwOnError();
    if (!data?.length) break;
    // Stable keyset pagination. Official timestamps, not scan order, control current state.
    for (const a of data) {
      scanned++;
      if (!caseReference(a.marketplace, a.raw_payload)) continue;
      const account = resolveLocalAccount(a.marketplace, a.raw_payload, accounts || []);
      if (!account) { unknownAccount++; continue; }
      const observation = normalizeCase(a, account);
      if (observation) { await persistCaseObservation(observation, db); consolidated++; }
    }
    cursor = String(data[data.length - 1].id);
    cursorTime = String(data[data.length - 1].received_at);
  }
  // Orders sometimes already contain the ML mediation IDs even after technical-event retention.
  // Identity and account come only from the saved order. Never fetch claim details here.
  cursor = "";
  let mediationCases = 0;
  for (;;) {
    let query = db.from("venda").select("id,marketplace,order_id,raw_data,updated_at")
      .eq("marketplace", "mercado_livre").order("id").limit(250);
    if (cursor) query = query.gt("id", cursor);
    const { data } = await query.throwOnError();
    if (!data?.length) break;
    for (const sale of data) {
      const raw = sale.raw_data || {};
      const accountId = raw.marketplace_account_id;
      if (!accountId || !(accounts || []).some(a => a.id === accountId && a.marketplace === "mercado_livre")) continue;
      const mediations = raw.payload?.order?.mediations;
      if (!Array.isArray(mediations)) continue;
      for (const mediation of mediations) {
        if (!mediation?.id) continue;
        const observation = normalizeCase({ id: `sale:${sale.id}:mediation:${mediation.id}`, marketplace: "mercado_livre",
          received_at: sale.updated_at, raw_payload: { topic: "post_purchase", claim_id: mediation.id,
            claim: { resource: "order", resource_id: sale.order_id } } }, accountId)!;
        observation.source = "persisted_sale_mediation";
        observation.identity_only = true;
        await persistCaseObservation(observation, db);
        mediationCases++;
      }
    }
    cursor = String(data[data.length - 1].id);
  }
  return { scanned, consolidated, unknownAccount, mediationCases };
}
