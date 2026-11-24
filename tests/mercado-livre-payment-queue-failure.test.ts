import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadPage } from "./helpers/page-harness";

function setup(activities: Record<string, any>[], options: {
  accountError?: Error;
  paymentError?: Error;
  orderError?: Error;
} = {}) {
  const failed: any[] = [];
  const retried: any[] = [];
  const completed: any[] = [];
  const module = loadPage("lib/marketplace-queue-worker.ts", {
    "./mercado-livre": {
      getMercadoLivreAccountForNotification: async () => {
        if (options.accountError) throw options.accountError;
        return { id: "account-1", name: "ML-ED", seller_id: "seller-1" };
      },
      getMercadoLivreItem: async () => ({}),
      getMercadoLivreLastModeration: async () => []
    },
    "./mercado-livre-orders": {
      processMercadoLivreOrder: async () => { if (options.orderError) throw options.orderError; return {}; },
      processMercadoLivreShipment: async () => ({})
    },
    "./mercado-livre-payment-webhook": {
      MercadoLivrePaymentIntegrityError: class MercadoLivrePaymentIntegrityError extends Error {},
      processMercadoLivrePaymentNotification: async () => { if (options.paymentError) throw options.paymentError; return {}; }
    },
    "./marketplace-queue": {
      completeQueuedActivity: async (...args: any[]) => { completed.push(args); return {}; },
      failQueuedActivity: async (...args: any[]) => { failed.push(args); },
      retryQueuedActivity: async (...args: any[]) => { retried.push(args); }
    },
    "./shopee-orders": { processShopeeOrderSynchronized: async () => ({}) },
    "./supabase-admin": { supabaseAdmin: () => ({ rpc: async () => ({ data: activities, error: null }) }) },
    "./marketplace-activity-labels": { activityDescription: () => "" },
    "./marketplace-moderations": {
      clearMarketplaceModeration: async () => {}, mercadoLivreModerationClass: () => null,
      recordMarketplaceModeration: async () => {}, shopeeModerationClass: () => null
    },
    "./outgoing-activities": { drainOutgoingActivities: async () => {}, enqueueOutgoingActivity: async () => "" },
    "./marketplace-conversations": {
      processMercadoLivreConversationNotification: async () => ({}),
      processShopeeConversationNotification: async () => ({}), syncMarketplaceConversationsSafetyNet: async () => ({})
    },
    "./marketplace-case-domain": { caseReference: () => false, normalizeCase: (value: any) => value },
    "./marketplace-cases": {
      persistCaseObservation: async () => {}, processCaseAndOrders: async () => ({}), processNewCaseEvent: async () => ""
    },
    "./marketplace-case-enrichment": { enrichMercadoLivreClaim: async () => ({}), enrichShopeeReturn: async () => ({}) },
    "./marketplace-case-reconciliation": { processCaseReconciliation: async () => ({}) }
  });
  return { processMarketplaceQueue: module.processMarketplaceQueue, failed, retried, completed };
}

test("payments API, partial-capture and persistence failures become explicit errors without automatic retry", async () => {
  for (const [raw_payload, options] of [
    [{ topic: "payments", user_id: "seller-1", resource: "/collections/1" }, { accountError: new Error("account API failure") }],
    [{ notification: { topic: "payments", user_id: "seller-1", resource: "/collections/1" } }, { paymentError: new Error("partial capture") }],
    [{ topic: "payments", user_id: "seller-1", resource: "/collections/1" }, { paymentError: new Error("finance persistence failure") }]
  ] as const) {
    const activity = { id: "event-1", marketplace: "mercado_livre", raw_payload };
    const worker = setup([activity], options as any);
    const result = await worker.processMarketplaceQueue();
    assert.equal(result.failed, 1);
    assert.equal(worker.failed.length, 1);
    assert.equal(worker.failed[0][0], "event-1");
    assert.equal(worker.failed[0][3], "payment_processing");
    assert.equal(worker.retried.length, 0);
  }
});

test("non-payments Mercado Livre events keep the existing automatic retry policy", async () => {
  const worker = setup([{
    id: "order-event", marketplace: "mercado_livre",
    raw_payload: { topic: "orders_v2", user_id: "seller-1", resource: "/orders/123" }
  }], { orderError: new Error("order API failure") });
  const result = await worker.processMarketplaceQueue();
  assert.equal(result.failed, 1);
  assert.equal(worker.retried.length, 1);
  assert.equal(worker.failed.length, 0);
});

test("stale payments leases become explicit errors instead of queue retries", () => {
  const migration = readFileSync("supabase/migrations/20261123190000_separate_sale_and_payment_finance.sql", "utf8");
  assert.match(migration, /update public\.marketplace_activities[\s\S]*status = 'error'[\s\S]*marketplace = 'mercado_livre'[\s\S]*'payments'/i);
  assert.match(migration, /status = 'processing'[\s\S]*not \(marketplace = 'mercado_livre'[\s\S]*'payments'/i);
});
