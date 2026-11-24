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
    source_id: "source-1001", operation_id: "operation-1001", operation_ids: ["operation-extra-1", { id: "operation-extra-2" }],
    ...overrides
  };
}
function finance(payments = [payment()]) {
  return { state: "complete", errors: [], payments, commercial_net: 10, approved_at: "2026-11-20T15:00:00.000Z", effective_release_at: "2026-11-30T15:00:00.000Z" };
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
    return { data: { persisted: true, sale_id: options.sale === false ? null : "sale-1", link_status: options.sale === false ? "pending" : "linked" }, error: null };
      }};
    }
  };
  const target = payment();
  const deps = {
    getToken: async () => "mock-token",
    getOrder: async () => ({ id: "9001", seller: { id: "seller-ed" }, currency_id: "BRL", shipping: { id: "ship-1" }, pack_id: "pack-1", payments: [{ id: "1001", status: "approved" }, { id: "1002", status: "approved" }] }),
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

test("released payment persists separately and resolves relationship identifiers", async () => {
  const f = fixture();
  const result = await processMercadoLivrePaymentNotification({ topic: "payments", user_id: "seller-ed", resource: "/collections/1001" }, account, "activity-1", f.deps as any);
  assert.equal(result.persisted, true);
  assert.equal(result.releaseStatus, "released");
  assert.equal(result.predictedReleaseAt, null);
  assert.equal(result.effectiveReleaseAt, "2026-11-30T15:00:00.000Z");
  assert.equal(result.saleId, "sale-1");assert.equal(result.saleLinkStatus,"linked");
  assert.equal(f.rpcCalls.length, 1);
  assert.equal(f.rpcCalls[0].name, "persist_mercado_livre_payment_finance");
  assert.deepEqual(f.rpcCalls[0].args.p_expected_payment_ids, ["1001", "1002"]);
  assert.equal(f.rpcCalls[0].args.p_payment_observations.length, 2);
  assert.equal(f.rpcCalls[0].args.p_allow_net_update, true);
  assert.deepEqual(f.rpcCalls[0].args.p_financial_capture.official_order,{id:"9001",seller_id:"seller-ed",currency_id:"BRL",shipping_id:"ship-1",pack_id:"pack-1",payment_ids:["1001","1002"]});
  assert.deepEqual(f.rpcCalls[0].args.p_financial_capture.original_references.resource,"/collections/1001");
  assert.deepEqual(f.rpcCalls[0].args.p_financial_capture.order_identifiers.filter((identifier: any) => identifier.identifierType === "OPERATION_ID").map((identifier: any) => identifier.identifierValue), ["operation-1001", "operation-extra-1", "operation-extra-2", "operation-1001", "operation-extra-1", "operation-extra-2"]);
  assert.equal(f.writes.length, 1);
});

test("sale not yet found persists finance with a pending relationship and never creates a sale", async () => {
  const absent = fixture({ sale: false });
  const result = await processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", absent.deps as any);
  assert.equal(result.persisted,true);assert.equal(result.saleId,null);assert.equal(result.saleLinkStatus,"pending");
  assert.equal(absent.rpcCalls.length,1);
  assert.equal(absent.writes.length,1);
});

test("collector, order, currency and notification account are checked before persistence", async () => {
  for (const overrides of [{ collector_id: "seller-gi" }, { order: { id: "9002", type: "mercadolibre" } }, { currency_id: "USD" }]) {
    const f = fixture();
    f.deps.readPayment = async () => payment(overrides);
    await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", f.deps as any));
    assert.equal(f.rpcCalls.length, 0);
  }
  const missingSeller = fixture();
  missingSeller.deps.getOrder = async () => ({ id: "9001", currency_id: "BRL", payments: [{ id: "1001" }] } as any);
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", missingSeller.deps as any), /seller|conta/i);
  const f = fixture();
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-gi", resource: "/collections/1001" }, account, "event", f.deps as any), /diverge/i);
  assert.equal(f.rpcCalls.length, 0);
});

test("partial sibling refresh persists observations but leaves the webhook pending explicit action", async () => {
  const f = fixture({ finance: { ...finance([payment()]), state: "partial", errors: [{ payment_id: "1002", code: "payment_unavailable" }], commercial_net: null } });
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "event", f.deps as any), /partial|parcial/i);
  assert.equal(f.rpcCalls.length, 1);
  assert.equal(f.rpcCalls[0].args.p_allow_net_update, false);
});

test("API and persistence failures reject the webhook without fabricating completion", async () => {
  const failedApi = fixture();
  failedApi.deps.readPayment = async () => { throw new Error("Mercado Pago unavailable"); };
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "api-failure", failedApi.deps as any), /indisponivel/);
  assert.equal(failedApi.rpcCalls.length, 0);
  const failedWrite = fixture({ failRpc: true });
  await assert.rejects(processMercadoLivrePaymentNotification({ user_id: "seller-ed", resource: "/collections/1001" }, account, "db-failure", failedWrite.deps as any), /persistencia financeira falhou/);
});
