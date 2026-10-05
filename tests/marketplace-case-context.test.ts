import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { caseContext, caseAttention, globalCaseAlert, CLAIM_CONTEXT_FILTER, RETURN_CONTEXT_FILTER, ACTIVE_ACTION_FILTER } from "../lib/marketplace-case-context";
import { caseIdentity, normalizeCase, transitionState } from "../lib/marketplace-case-domain";
import { loadCaseList, knownCaseDeadlines } from "../lib/marketplace-case-list";
import { deadlineLabel } from "../app/central-reclamacoes/case-display";

const normalize = (data: Record<string, any>, marketplace = "shopee") => normalizeCase({
  id: "event", marketplace, received_at: "2026-10-05T10:00:00Z", raw_payload: marketplace === "shopee"
    ? { code: 29, data: { return_sn: "R1", ...data } }
    : { topic: "post_purchase", claim_id: "C1", claim: data }
}, "account")!;
const row = (data: Record<string, any>, marketplace = "shopee"): Record<string, any> => {
  const observation = normalize(data, marketplace);
  return { marketplace, case_type: observation.case_type, ...observation.snapshot };
};

test("1. required seller complaint is the only global alert", () => {
  const r = row({ status: "open", players: [{ role: "respondent", type: "seller", available_actions: [{ action: "reply", mandatory: true }] }] }, "mercado_livre");
  assert.equal(caseContext(r), "claim"); assert.equal(caseAttention(r), "ACTION_REQUIRED"); assert.equal(globalCaseAlert(r), true);
});
test("2. complaint waiting for buyer remains monitoring", () => {
  const r = row({ status: "open", responsible: "buyer" }, "mercado_livre");
  assert.equal(caseContext(r), "claim"); assert.equal(caseAttention(r), "MONITORING"); assert.equal(globalCaseAlert(r), false);
});
test("3. real related return changes context without changing identity or history owner", () => {
  const initial = normalize({ status: "open" }, "mercado_livre");
  for (const related_entities of [["return"], [{ type: "return", id: 123 }]]) {
    const next = normalize({ status: "open", related_entities }, "mercado_livre");
    assert.equal(caseIdentity(initial), caseIdentity(next));
    assert.equal(caseContext({ case_type: next.case_type, ...next.snapshot }), "return");
    assert.equal(next.snapshot.related_claim_id, "C1");
    assert.equal(transitionState(next.snapshot).return_entity_created, true);
  }
});
test("4. requested solution alone is not a return", () => {
  const r = row({ status: "open", expected_resolution: "return_product", resolution: { reason: "return_product" } }, "mercado_livre");
  assert.equal(caseContext(r), "claim");
});
test("5. buyer shipping deadline never becomes seller attention", () => {
  const observation = normalize({ return_status: "ACCEPTED", return_ship_due_date: 1800000000 });
  const r = { case_type: "return", ...observation.snapshot };
  assert.equal(caseAttention(r), "MONITORING"); assert.equal(globalCaseAlert(r), false);
  assert.equal(observation.deadlines[0].responsible, "buyer");
  assert.match(deadlineLabel(observation.deadlines[0]), /Prazo do comprador/);
  assert.doesNotMatch(deadlineLabel(observation.deadlines[0]), /vendedor/);
});
for (const [number, logistics_status] of [[6, "in_transit"], [7, "awaiting_auto_close"]] as const) {
  test(`${number}. normal reverse logistics is monitoring without global alert`, () => {
    const r = row({ return_status: "ACCEPTED", logistics_status, due_date: 1800000000 });
    assert.equal(caseContext(r), "return"); assert.equal(caseAttention(r), "MONITORING"); assert.equal(globalCaseAlert(r), false);
  });
}
test("8. required return validation is red locally and absent from global alert", () => {
  const r = row({ return_status: "ACCEPTED", validation_type: "received_product", follow_up_action_list: [{ action: "validate_received", responsible: "seller", mandatory: true }] });
  assert.equal(caseContext(r), "return"); assert.equal(caseAttention(r), "ACTION_REQUIRED"); assert.equal(globalCaseAlert(r), false);
});

// Real Supabase client with an in-memory HTTP transport: verifies serialized queries, no remote database.
async function searchQuery(search: string, context = "return") {
  const urls: URL[] = [];
  const fixture = { id: "case", marketplace: "shopee", case_type: "return", status: "ACCEPTED", needs_action: null,
    reverse_logistics: { contact_name: "Maria Retorno", tracking: "BR123", return_id: "R1" }, updated_at: "2026-10-05", snapshot_order_at: null };
  const db = createClient("https://cases-test.invalid", "test-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(url.hostname, "cases-test.invalid");
    const data = url.pathname.endsWith("marketplace_cases") ? [fixture] : [];
    return new Response(init?.method === "HEAD" ? null : JSON.stringify(data), { headers: { "content-type": "application/json", "content-range": "0-0/1" } });
  } } });
  const result = await loadCaseList({ search, context }, db);
  return { urls, result };
}
for (const [number, search, field] of [
  [9, "SKU123", "search_item.sku"], [10, "ORDER123", "search_sale.order_id"],
  [11, "CASE123", "external_case_id.ilike"], [12, "Produto123", "search_product.or"],
  [13, "Maria Retorno", "reverse_logistics->>contact_name.ilike"], [14, "BR123", "reverse_logistics->>tracking.ilike"]] as const) {
  test(`${number}. unified search includes ${field} using local data only`, async () => {
    const { urls, result } = await searchQuery(search);
    const query = urls.find(url => url.searchParams.get("select")?.startsWith("id,marketplace,case_type"))!;
    assert.ok(query); assert.ok(decodeURIComponent(query.search).includes(field));
    assert.ok(decodeURIComponent(query.search).includes(search.replace(/ /g, "+")) || decodeURIComponent(query.search).includes(search));
    assert.equal(result.rows.length, 1); assert.deepEqual(result.contextCounts, { claim: 0, return: 1 });
    assert.equal(result.filters.context, "return");
  });
}
test("15. absent logistics contact is null, masked buyer is never copied", () => {
  const r = row({ buyer_name: "m***a", buyer: { name: "m***a" } });
  assert.equal(r.reverse_logistics.contact_name, null); assert.equal(r.buyer_name, "m***a");
});
test("16. separate buyer, seller and evidence deadlines retain responsibility", () => {
  const o = normalize({ return_ship_due_date: 1800000000, return_seller_due_date: 1800000100, seller_evidence_deadline: 1800000200 });
  assert.deepEqual(o.deadlines.map(d => [d.purpose, d.responsible]), [["buyer_return_shipping", "buyer"], ["seller_response", "seller"], ["seller_evidence", "seller"]]);
  assert.equal(o.snapshot.needs_action, true);
});
test("17. generic deadline and optional unknown follow-up never create seller obligation", () => {
  const o = normalize({ due_date: 1800000000, follow_up_action_list: ["UNRECOGNIZED_ACTION"], validation_type: "some_type" });
  assert.equal(o.snapshot.needs_action, null); assert.equal(o.deadlines[0].responsible, "unknown");
  assert.equal(o.actions[0].mandatory, null); assert.match(deadlineLabel(o.deadlines[0]), /responsável não informado/);
  assert.equal(knownCaseDeadlines({ snapshot_order_at: o.order_at, observations: [{ order_at: o.order_at, deadlines: o.deadlines }] }, true).length, 1);
});
test("18. historical classification cannot call marketplaces and context tabs retain search", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External request prohibited"); };
  try {
    for (const case_type of ["claim", "return"]) {
      const r = { marketplace: "mercado_livre", case_type, needs_action: null, status: null };
      assert.equal(caseContext(r), case_type); assert.equal(caseAttention(r), "MONITORING"); assert.equal(globalCaseAlert(r), false);
    }
    const { result } = await searchQuery("Maria Retorno", "claim");
    assert.equal(result.total, 0); assert.deepEqual(result.contextCounts, { claim: 0, return: 1 });
  } finally { globalThis.fetch = original; }
});
test("terminal states suppress stale action flags in both contexts", () => {
  for (const case_type of ["claim", "return"]) {
    const r = { marketplace: "mercado_livre", case_type, status: "closed", needs_action: true };
    assert.equal(caseAttention(r), "MONITORING"); assert.equal(globalCaseAlert(r), false);
  }
});
test("normal transport captures contact and carrier independently of buyer name", () => {
  const r = row({ buyer_name: "m***a", reverse_logistics: { sender: { name: "Maria Retorno" }, tracking_number: "BR123", carrier: "Correios" } });
  assert.equal(r.reverse_logistics.contact_name, "Maria Retorno"); assert.equal(r.reverse_logistics.tracking, "BR123");
  assert.equal(r.reverse_logistics.carrier, "Correios"); assert.equal(r.buyer_name, "m***a");
});
test("context and active filters are composed as AND, never replacing each other", async () => {
  const urls: URL[] = [];
  const db = createClient("https://cases-test.invalid", "key", { auth: { persistSession: false }, global: { fetch: async input => {
    urls.push(new URL(String(input))); return new Response("[]", { headers: { "content-type": "application/json", "content-range": "*/0" } });
  } } });
  await db.from("marketplace_cases").select("id", { count: "exact", head: true }).or(CLAIM_CONTEXT_FILTER).or(ACTIVE_ACTION_FILTER);
  assert.deepEqual(urls[0].searchParams.getAll("or"), [`(${CLAIM_CONTEXT_FILTER})`, `(${ACTIVE_ACTION_FILTER})`]);
  await loadCaseList({ context: "return" }, db);
  assert.ok(urls.some(url => url.searchParams.getAll("or").includes(`(${RETURN_CONTEXT_FILTER})`)));
});
