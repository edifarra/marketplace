import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { caseIdentity, normalizeCase, safeConversation } from "../lib/marketplace-case-domain";
import { processCaseAndOrders, processCaseEvent, resolveLocalAccount, consolidateLocalCases } from "../lib/marketplace-cases";

const activity = (marketplace = "shopee", id = "a", caseId = "R1", data: Record<string, any> = {}) => ({
  id, marketplace, received_at: "2026-10-04T12:00:00Z",
  raw_payload: marketplace === "shopee" ? { code: 29, shop_id: 10, data: { return_sn: caseId, order_sn: "O1", ...data } }
    : { topic: "post_purchase", user_id: 20, resource: `/post-purchase/v1/claims/${caseId}`, claim: data }
});
const normalize = (a: Record<string, any>) => normalizeCase(a, "account")!;

test("1. multiple deliveries identify the same ML Claim", () => {
  assert.equal(caseIdentity(normalize(activity("mercado_livre", "a", "123"))), caseIdentity(normalize(activity("mercado_livre", "b", "123"))));
});
test("2. multiple pushes identify the same return", () => {
  assert.equal(caseIdentity(normalize(activity())), caseIdentity(normalize(activity("shopee", "b"))));
});
test("3. different returns on the same order have different identities", () => {
  const a = normalize(activity()), b = normalize(activity("shopee", "b", "R2"));
  assert.equal(a.snapshot.order_id, b.snapshot.order_id);
  assert.notEqual(caseIdentity(a), caseIdentity(b));
});
test("4. redelivery preserves observation key", () => {
  assert.equal(normalize(activity()).source_key, normalize(activity()).source_key);
});
test("6. buyer/product/SKU alone never associate a conversation; ambiguous orders also remain unlinked", () => {
  const c = { id: "c", marketplace: "shopee", marketplace_account_id: "account", order_id: "other", buyer_id: "same", conversation_type: "chat" };
  assert.equal(safeConversation([c], "shopee", "account", "O1"), null);
  assert.equal(safeConversation([{ ...c, order_id: "O1" }], "shopee", "account", "O1"), "c");
  assert.equal(safeConversation([{ ...c, order_id: "O1" }, { ...c, id: "c2", order_id: "O1" }], "shopee", "account", "O1"), null);
});
test("7. opened does not mean seller action and unknown fields stay unknown", () => {
  const { snapshot } = normalize(activity("shopee", "a", "R1", { return_status: "OPENED" }));
  assert.equal(snapshot.needs_action, null); assert.equal(snapshot.responsible, "unknown");
  assert.equal(snapshot.refund_amount, null); assert.equal(snapshot.reverse_logistics.tracking, null);
});
test("11. unknown deadline purpose stays unknown alongside known shipping deadline", () => {
  const { deadlines } = normalize(activity("shopee", "a", "R1", { due_date: 1800000000, return_ship_due_date: 1800000100 }));
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines.find(d => d.official_field === "due_date")!.purpose, "unknown");
  assert.equal(deadlines.find(d => d.official_field === "return_ship_due_date")!.responsible, "buyer");
});
test("12. Shopee reputation cannot become not_affected", () => {
  assert.equal(normalize(activity("shopee", "a", "R1", { affects_reputation: "not_affected" })).snapshot.reputation_impact, "unknown");
});
test("ML required capabilities and timestamps are persisted independently", () => {
  const o = normalize(activity("mercado_livre", "a", "123", { status: "opened", players: [{ role: "respondent", type: "seller",
    available_actions: [{ action: "send_message_to_complainant", mandatory: true, due_date: "2026-10-04T10:00:00-04:00" }] }] }));
  assert.equal(o.snapshot.needs_action, true); assert.equal(o.snapshot.responsible, "seller");
  assert.equal(o.actions[0].deadline, "2026-10-04T14:00:00.000Z");
  assert.equal(o.deadlines[0].purpose, "action:send_message_to_complainant");
});
test("account association requires explicit matching seller/shop", () => {
  const accounts = [{ id: "a", marketplace: "mercado_livre", seller_id: "20" }];
  assert.equal(resolveLocalAccount("mercado_livre", {}, accounts), null);
  assert.equal(resolveLocalAccount("mercado_livre", { user_id: 20 }, accounts), "a");
});

function dependencies(eligible = true) {
  const observations = new Map<string, any>(); const cases = new Set<string>();
  let calls = 0, failures = 0, fail = false;
  const deps = {
    persist: async (o: any) => { cases.add(caseIdentity(o)); observations.set(o.source_key, o); return "case"; },
    eligible: async () => eligible,
    enriched: async (_id: string, key: string) => observations.has(key),
    enrich: async () => { calls++; if (fail) throw new Error("signed URL with secrets"); return { return_sn: "R1", order_sn: "O1", return_status: "ACCEPTED" }; },
    failure: async () => { failures++; }, history: async () => {}
  };
  return { deps, observations, cases, setFail: (v: boolean) => { fail = v; }, calls: () => calls, failures: () => failures };
}
test("8. historical queued events cannot enrich", async () => {
  const d = dependencies(false); await processCaseEvent(activity(), "account", d.deps);
  assert.equal(d.calls(), 0); assert.equal(d.cases.size, 1);
});
test("9. new event enrichment updates same case and retry skips successful detail", async () => {
  const d = dependencies(); await processCaseEvent(activity(), "account", d.deps);
  await processCaseEvent(activity(), "account", d.deps);
  assert.equal(d.calls(), 1); assert.equal(d.cases.size, 1); assert.equal(d.observations.size, 2);
});
test("10. failed enrichment preserves local case and is retryable", async () => {
  const d = dependencies(); d.setFail(true);
  await assert.rejects(processCaseEvent(activity(), "account", d.deps), /preservados para retry/);
  assert.equal(d.cases.size, 1); assert.equal(d.observations.size, 1); assert.equal(d.failures(), 1);
  d.setFail(false); await processCaseEvent(activity(), "account", d.deps);
  assert.equal(d.calls(), 2); assert.equal(d.cases.size, 1);
});
test("local consolidation uses only DB reads/RPC and includes saved mediations", async () => {
  let writes = 0;
  const pages: Record<string, any[][]> = {
    config_marketplace_accounts: [[{ id: "account", marketplace: "shopee", shop_id: "10" }, { id: "ml", marketplace: "mercado_livre" }]],
    marketplace_case_rollout: [[{ enrichment_starts_at: "2026-10-05T00:00:00Z" }]],
    marketplace_activities: [[activity()], []],
    venda: [[{ id: "sale", marketplace: "mercado_livre", order_id: "O2", updated_at: "2026-10-03T00:00:00Z",
      raw_data: { marketplace_account_id: "ml", payload: { order: { mediations: [{ id: 123 }] } } } }], []]
  };
  const db: any = {
    from: (table: string) => {
      const q: any = {}; for (const method of ["select", "lt", "in", "order", "limit", "or", "gt", "eq"]) q[method] = () => q;
      q.throwOnError = async () => ({ data: pages[table].shift() || [] });
      q.single = () => ({ throwOnError: async () => ({ data: pages[table].shift()![0] }) }); return q;
    },
    rpc: () => ({ throwOnError: async () => { writes++; return { data: "case" }; } })
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External call prohibited"); };
  try {
    const result = await consolidateLocalCases(db);
    assert.equal(result.consolidated, 1); assert.equal(result.mediationCases, 1); assert.equal(writes, 2);
  } finally { globalThis.fetch = originalFetch; }
});
test("order failure preserves case update; case failure does not skip any order", async () => {
  let persisted = false; const orders: string[] = [];
  await assert.rejects(processCaseAndOrders(async () => { persisted = true; return "case"; }, ["a"], async () => { throw new Error("stock"); }), /stock/);
  assert.equal(persisted, true);
  await assert.rejects(processCaseAndOrders(async () => { throw new Error("enrichment"); }, ["a", "b"], async id => { orders.push(id); }), /enrichment/);
  assert.deepEqual(orders, ["a", "b"]);
});
test("Shopee worker reuses activity identity and defers queue completion", () => {
  const worker = readFileSync(new URL("../lib/marketplace-queue-worker.ts", import.meta.url), "utf8");
  const branch = worker.slice(worker.indexOf('if (code === 29 &&'), worker.indexOf('if (account && hasShopeeItemStatus'));
  assert.match(branch, /processCaseAndOrders/);
  assert.match(branch, /String\(activity.id\), true/);
  assert.match(branch, /completeQueuedActivity/);
});
