import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { processMercadoLivrePaymentNotification, paymentIdFromNotification } from "../lib/mercado-livre-payment-webhook";
import type { MarketplaceAccountConfig } from "../lib/mercado-livre";

const account: MarketplaceAccountConfig = {
  id: "account-ed", name: "ML-ED", marketplace: "mercado_livre", active: true, seller_id: "seller-ed"
};
function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "1001", collector_id: "seller-ed", order: { id: "9001", type: "mercadolibre" },
    currency_id: "BRL", status: "approved", money_release_status: "released",
    money_release_date: "2026-11-30T12:00:00-03:00", date_approved: "2026-11-20T12:00:00-03:00",
    ...overrides
  };
}
function finance(payments = [payment()]) {
  return { state: "complete", errors: [], payments, commercial_net: 10, approved_at: "2026-11-20T15:00:00.000Z", effective_release_at: null };
}
function fixture(options: { saleAccount?: string; sale?: boolean; failRpc?: boolean; finance?: any } = {}) {
  const writes: any[] = [];
  const rpcCalls: any[] = [];
  const sale = options.sale === false ? null : { id: "sale-1", raw_data: { marketplace_account_id: options.saleAccount || account.id }, valor_liquido: 7, data_pagamento: null };
  const db: any = {
    from(table: string) {
      assert.equal(table, "venda");
      const query: any = new Proxy({}, { get(_target, method: string) {
        if (method === "maybeSingle") return () => query;
        if (method === "throwOnError") return async () => ({ data: sale, error: null });
        if (method === "select" || method === "eq") return () => query;
        throw new Error(`Unexpected query method ${method}`);
      }});
      return query;
    },
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      return { throwOnError: async () => {
        if (options.failRpc) throw new Error("database unavailable");
        writes.push(args);
        return { data: { updated: true, sale_id: "sale-1" }, error: null };
      }};
    }
  };
  const target = payment();
  const deps = {
    getToken: async () => "mock-token",
    getOrder: async () => ({ id: "9001", seller: { id: "seller-ed" }, currency_id: "BRL", payments: [{ id: "1001", status: "approved" }, { id: "1002", status: "approved" }] }),
    capture: async (_order: any, _seller: string, read: (id: string) => Promise<any>) => {
      assert.deepEqual(await read("1001"), target);
      if (options.finance) return options.finance;
      return finance([target, payment({ id: "1002" })]);
    },
    database: () => db,
    readPayment: async (id: string) => id === target.id ? target : payment({ id })
  };
  return { deps, writes, rpcCalls, target };
}

test("payments webhook extracts payment identity and routes to the finance processor", () => {
  assert.equal(paymentIdFromNotification({ resource: "/collections/12345" }), "12345");
  assert.equal(paymentIdFromNotification({ resource: "/v1/payments/12345?x=1" }), "12345");
  assert.equal(paymentIdFromNotification({ data: { id: 12345 } }), "12345");
  assert.equal(paymentIdFromNotification({ resource: "/orders/12345", id: "webhook-id" }), "");
  const source = readFileSync("lib/marketplace-queue-worker.ts", "utf8");
  assert.match(source, /topic === "payments"[\s\S]*processMercadoLivrePaymentNotification/);
  assert.match(readFileSync("app/api/webhooks/mercado-livre/route.ts", "utf8"), /enqueueMarketplaceActivity/);
});

test("released payment captures prediction and approval then persists existing sale without effective release date", async () => {
  const f = fixture();
  const result = await processMercadoLivrePaymentNotification({ topic: "payments", user_id: "seller-ed", resource: "/collections/1001" }, account, "activity-1", f.deps as any);
  assert.equal(result.persisted, true);
  assert.equal(result.releaseStatus, "released");
  assert.equal(result.predictedReleaseAt, f.target.money_release_date);
  assert.equal(result.effectiveReleaseAt, null);
  assert.equal(f.rpcCalls.length, 1);
  assert.equal(f.rpcCalls[0].name, "persist_mercado_livre_payment_finance");
  assert.deepEqual(f.rpcCalls[0].args.p_expected_payment_ids, ["1001", "1002"]);
  assert.equal(f.rpcCalls[0].args.p_payment_observations.length, 2);
  assert.equal(f.rpcCalls[0].args.p_allow_net_update, true);
  assert.equal(f.writes.length, 1);
});

test("account identity mismatch and missing existing sale fail closed without creating a sale", async () => {
  const wrongAccount = fixture({ saleAccount: "account-gi" });
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", wrongAccount.deps as any), /belongs to another|pertence a outra conta/i);
  assert.equal(wrongAccount.rpcCalls.length, 0);
  const absent = fixture({ sale: false });
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", absent.deps as any), /not registered|nao cadastrada/i);
  assert.equal(absent.rpcCalls.length, 0);
});

test("collector, order, currency and notification account are checked before persistence", async () => {
  for (const overrides of [{ collector_id: "seller-gi" }, { order: { id: "9002", type: "mercadolibre" } }, { currency_id: "USD" }]) {
    const f = fixture();
    f.deps.readPayment = async () => payment(overrides);
    await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", f.deps as any));
    assert.equal(f.rpcCalls.length, 0);
  }
  const f = fixture();
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-gi", resource: "/collections/1001" }, account, "event", f.deps as any), /diverge/i);
  assert.equal(f.rpcCalls.length, 0);
});

test("partial sibling refresh persists observations but cannot overwrite aggregate liquid and remains retryable", async () => {
  const f = fixture({ finance: { ...finance([payment()]), state: "partial", errors: [{ payment_id: "1002", code: "payment_unavailable" }], commercial_net: null } });
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", f.deps as any), /partial|parcial/i);
  assert.equal(f.rpcCalls.length, 1);
  assert.equal(f.rpcCalls[0].args.p_allow_net_update, false);
});

test("API and persistence failures reject the event so the queue can retry", async () => {
  const failedApi = fixture();
  failedApi.deps.readPayment = async () => { throw new Error("Mercado Pago unavailable"); };
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "api-failure", failedApi.deps as any), /unavailable/);
  assert.equal(failedApi.rpcCalls.length, 0);
  const failedWrite = fixture({ failRpc: true });
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "db-failure", failedWrite.deps as any), /database unavailable/);
});
