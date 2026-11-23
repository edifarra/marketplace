import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

const migrations = [
  "supabase/migrations/20261122120000_persist_mercado_livre_payment_finance.sql",
  "supabase/migrations/20261122130000_persist_mercado_livre_release_date.sql",
  "supabase/migrations/20261123130000_exclude_nonreceiving_ml_attempts_release.sql"
];
const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const saleId = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-11-22T12:00:00Z";
const expectedIds = ["payment-1", "payment-2"];
const snapshot = (id, status = "approved", cents = 1000, releaseStatus = "released", updatedAt = observedAt,
  releaseDate = releaseStatus === "pending" ? "2026-11-30T15:00:00Z" : "2026-11-22T12:00:00Z") => ({
  id, status, currency_id: "BRL", date_approved: "2026-11-20T15:00:00Z",
  money_release_date: releaseDate, money_release_status: releaseStatus,
  api_updated_at: updatedAt, observed_at: observedAt, commercial_net_cents: status === "approved" ? cents : null,
  transaction_amount_refunded_cents: 0, charges: [], transaction_amount: 10, net_received_amount: 10
});
const isoTimestamp = value => value == null ? null : new Date(value).toISOString();
const capture = { state: "complete", commercial_net: 20, effective_release_at: null, collected_at: observedAt, basis: "test" };
const terminalNoReceipt = (id, status = "cancelled", overrides = {}) => ({
  ...snapshot(id, status, null, "pending", observedAt, null), date_approved: null,
  transaction_amount_refunded: null, net_received_amount: 0, ...overrides
});

async function setup() {
  assert.ok(process.env.PGLITE_MODULE, "Run with scripts/smart-test-runner.mjs");
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table config_marketplace_accounts(id uuid primary key, marketplace text not null, seller_id text, account_id text);
    create table venda(id uuid primary key, marketplace text not null, order_id text not null, raw_data jsonb not null,
      valor_liquido numeric(12,2) not null default 0, data_pagamento timestamptz, data_liberacao timestamptz, updated_at timestamptz);
    insert into config_marketplace_accounts values ('${accountId}','mercado_livre','seller-ed',null),('${otherAccountId}','mercado_livre','seller-gi',null);
    insert into venda(id,marketplace,order_id,raw_data,valor_liquido) values
      ('${saleId}','mercado_livre','order-1','{"marketplace_account_id":"${accountId}"}',23.50);`);
  for (const migration of migrations) await db.exec(readFileSync(migration, "utf8"));
  return db;
}

async function persist(db, account = accountId, payments = [], options = {}) {
  return db.query(`select public.persist_mercado_livre_payment_finance(
    $1::uuid,$2::text,$3::text,$4::jsonb,$5::jsonb,$6::jsonb,$7::boolean,$8::text) as result`, [
    account, options.seller || "seller-ed", "order-1", JSON.stringify(options.expected || expectedIds), JSON.stringify(payments),
    JSON.stringify(options.capture || capture), options.allowNet ?? true, options.activity || "event-1"
  ]);
}

 test("atomic payment merge preserves siblings under concurrent deliveries and is idempotent", async () => {
  const db = await setup();
  try {
    await Promise.all([
      persist(db, accountId, [snapshot("payment-1")], { activity: "event-a" }),
      persist(db, accountId, [snapshot("payment-2")], { activity: "event-b" })
    ]);
    let row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(row.valor_liquido, "20.00");
    assert.equal(Object.keys(row.raw_data.financial_capture.payments_by_id).length, 2);
    assert.deepEqual(row.raw_data.financial_capture.payments.map(p => p.id), expectedIds);
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-22T12:00:00.000Z");
    assert.equal(Date.parse(row.raw_data.financial_capture.effective_release_at), Date.parse(row.data_liberacao));
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-1"].money_release_date, "2026-11-22T12:00:00Z");
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-1"].money_release_status, "released");
    await persist(db, accountId, [snapshot("payment-1")], { activity: "duplicate-event" });
    row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(Object.keys(row.raw_data.financial_capture.payments_by_id).length, 2);
    assert.equal(row.valor_liquido, "20.00");
    assert.notEqual(row.raw_data.financial_capture.payments_by_id["payment-1"].source_activity_id, "duplicate-event");
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending", observedAt)], { activity: "same-version-stale" });
    row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-1"].money_release_status, "released");
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-22T12:00:00.000Z");
    assert.equal(Date.parse(row.raw_data.financial_capture.effective_release_at), Date.parse(row.data_liberacao));
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending", "2026-11-20T10:00:00Z")], { activity: "stale-pending" });
    row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-22T12:00:00.000Z");
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-1"].money_release_status, "released");
  } finally { await db.close(); }
});

test("account boundary, legacy sale preservation, and partial captures are enforced", async () => {
  const db = await setup();
  try {
    await assert.rejects(persist(db, otherAccountId, [snapshot("payment-1")]));
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending")], {
      allowNet: false, capture: { state: "partial", commercial_net: null, effective_release_at: null, errors: [{ code: "partial" }] }
    });
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "released", "2026-11-22T12:05:00Z")], {
      allowNet: false, capture: { state: "partial", commercial_net: null, effective_release_at: null, errors: [{ code: "partial" }] }
    });
    const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(row.valor_liquido, "23.50");
    assert.equal(row.raw_data.financial_capture.commercial_net, undefined);
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-1"].money_release_status, "released");
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-1"].money_release_date, "2026-11-22T12:00:00Z");
    assert.equal(row.data_liberacao, null);
    await persist(db, accountId, [
      snapshot("payment-1", "approved", 1000, "released", "2026-11-22T12:05:00Z", "2026-11-22T12:05:00Z"),
      snapshot("payment-2", "approved", 1000, "released", "2026-11-22T12:10:00Z", "2026-11-22T12:10:00Z")
    ], { allowNet: false, capture: { state: "partial", commercial_net: null, effective_release_at: null, errors: [{ code: "partial" }] } });
    const released = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(released.data_liberacao), "2026-11-22T12:10:00.000Z");
    assert.equal(released.valor_liquido, "23.50");
  } finally { await db.close(); }
});

test("confirmed release replaces a stored pending forecast without losing sale financials", async () => {
  const db = await setup();
  try {
    await db.query(`update venda set data_liberacao=$1,raw_data=jsonb_set(raw_data,'{financial_capture}', $2::jsonb, true) where id=$3`, [
      "2026-11-30T15:00:00Z",
      JSON.stringify({ state: "partial", commercial_net: 20, payments_by_id: {
        "payment-1": snapshot("payment-1", "approved", 1000, "pending"),
        "payment-2": snapshot("payment-2", "approved", 1000, "pending")
      } }), saleId
    ]);
    await persist(db, accountId, [
      snapshot("payment-1", "approved", 1000, "released", "2026-11-22T12:05:00Z", "2026-11-22T12:05:00Z"),
      snapshot("payment-2", "approved", 1000, "released", "2026-11-22T12:10:00Z", "2026-11-22T12:10:00Z")
    ]);
    const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-22T12:10:00.000Z");
    assert.equal(row.valor_liquido, "20.00");
    assert.equal(Date.parse(row.raw_data.financial_capture.effective_release_at), Date.parse(row.data_liberacao));
  } finally { await db.close(); }
});

test("verified cancelled/rejected no-receipt attempts are excluded only from release completeness", async () => {
  const db = await setup();
  try {
    await persist(db, accountId, [
      snapshot("payment-1", "approved", 1000, "released"),
      terminalNoReceipt("payment-2", "cancelled"),
      terminalNoReceipt("payment-3", "rejected")
    ], { expected: ["payment-1", "payment-2", "payment-3"], capture: {
      ...capture, order_payment_ids: ["payment-1", "payment-2", "payment-3"], order_api_updated_at: "2026-11-22T12:00:00Z"
    } });
    const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-22T12:00:00.000Z");
    assert.deepEqual(row.raw_data.financial_capture.order_payment_ids, ["payment-1", "payment-2", "payment-3"]);
    assert.equal(isoTimestamp(row.raw_data.financial_capture.effective_release_at), "2026-11-22T12:00:00.000Z");
  } finally { await db.close(); }
});

test("missing or contradictory terminal evidence stays unproven, and terminal-only orders get no date", async () => {
  for (const invalidTerminal of [
    terminalNoReceipt("payment-1", "rejected", { net_received_amount: null }),
    terminalNoReceipt("payment-1", "cancelled", { transaction_amount_refunded: 1 }),
    terminalNoReceipt("payment-1", "rejected", { date_approved: "2026-11-20T15:00:00Z" }),
    terminalNoReceipt("payment-1", "cancelled", { money_release_status: "released", money_release_date: "2026-11-22T12:00:00Z" })
  ]) {
    const db = await setup();
    try {
      await persist(db, accountId, [invalidTerminal, snapshot("payment-2")], { expected: ["payment-1", "payment-2"] });
      const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
      assert.equal(row.data_liberacao, null);
      assert.equal(row.raw_data.financial_capture.effective_release_at, undefined);
    } finally { await db.close(); }
  }
  const db = await setup();
  try {
    await persist(db, accountId, [terminalNoReceipt("payment-1", "cancelled")], { expected: ["payment-1"] });
    const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(row.data_liberacao, null);
    assert.equal(row.raw_data.financial_capture.effective_release_at, undefined);
  } finally { await db.close(); }
});

test("a new relevant payment invalidates current-set proof; stale/equal order lists cannot erase it", async () => {
  const db = await setup();
  try {
    const p1 = snapshot("payment-1", "approved", 1000, "released", "2026-11-20T12:00:00Z", "2026-11-20T12:00:00Z");
    await persist(db, accountId, [p1], { expected: ["payment-1"], capture: {
      ...capture, order_payment_ids: ["payment-1"], order_api_updated_at: "2026-11-20T12:00:00Z"
    } });
    let row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-20T12:00:00.000Z");

    const p2Pending = snapshot("payment-2", "pending", null, "pending", "2026-11-22T12:00:00Z", "2026-11-30T12:00:00Z");
    await persist(db, accountId, [p1, p2Pending], { expected: ["payment-1", "payment-2"], capture: {
      ...capture, order_payment_ids: ["payment-1", "payment-2"], order_api_updated_at: "2026-11-22T12:00:00Z"
    } });
    row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-20T12:00:00.000Z");
    assert.equal(row.raw_data.financial_capture.effective_release_at, undefined);
    assert.equal(isoTimestamp(row.raw_data.financial_capture.previous_effective_release_at), "2026-11-20T12:00:00.000Z");

    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending", "2026-11-19T12:00:00Z")], {
      expected: ["payment-1"], capture: { ...capture, order_payment_ids: ["payment-1"], order_api_updated_at: "2026-11-19T12:00:00Z" }
    });
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending", "2026-11-22T12:00:00Z")], {
      expected: ["payment-1"], capture: { ...capture, order_payment_ids: ["payment-1"], order_api_updated_at: "2026-11-22T12:00:00Z" }
    });
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending", "2026-11-22T12:00:00Z")], {
      expected: ["payment-1"], capture: { ...capture, order_payment_ids: ["payment-1"] }
    });
    row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.deepEqual(row.raw_data.financial_capture.order_payment_ids, ["payment-1", "payment-2"]);
    assert.equal(row.raw_data.financial_capture.payments_by_id["payment-2"].status, "pending");
    assert.equal(row.raw_data.financial_capture.effective_release_at, undefined);
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-20T12:00:00.000Z");

    const p2Released = snapshot("payment-2", "approved", 1000, "released", "2026-11-23T12:00:00Z", "2026-11-23T12:00:00Z");
    await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "released", "2026-11-23T12:00:00Z", "2026-11-20T12:00:00Z"), p2Released], {
      expected: ["payment-1", "payment-2"], capture: { ...capture, order_payment_ids: ["payment-1", "payment-2"], order_api_updated_at: "2026-11-23T12:00:00Z" }
    });
    row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-23T12:00:00.000Z");
    assert.equal(isoTimestamp(row.raw_data.financial_capture.effective_release_at), "2026-11-23T12:00:00.000Z");
  } finally { await db.close(); }
});

test("migration serializes existing sale rows and exposes persistence only to service_role", async () => {
  const db = await setup();
  try {
    const acl = (await db.query(`select has_function_privilege('anon','persist_mercado_livre_payment_finance(uuid,text,text,jsonb,jsonb,jsonb,boolean,text)','execute') anon,
      has_function_privilege('authenticated','persist_mercado_livre_payment_finance(uuid,text,text,jsonb,jsonb,jsonb,boolean,text)','execute') authenticated,
      has_function_privilege('service_role','persist_mercado_livre_payment_finance(uuid,text,text,jsonb,jsonb,jsonb,boolean,text)','execute') service`)).rows[0];
    assert.deepEqual(acl, { anon: false, authenticated: false, service: true });
    const sql = migrations.map(migration => readFileSync(migration, "utf8")).join("\n");
    assert.match(sql, /for update/i);
    assert.match(sql, /data_liberacao\s*=\s*case[\s\S]*effective_release_at/i);
  } finally { await db.close(); }
});

test("pending forecast RPC return equals the date actually preserved by the update", async () => {
  const db = await setup();
  try {
    await db.query(`update venda set data_liberacao=$1,raw_data=jsonb_set(raw_data,'{financial_capture}',$2::jsonb,true) where id=$3`, [
      "2026-11-30T15:00:00Z", JSON.stringify({ payments_by_id: {
        "payment-1": snapshot("payment-1", "approved", 1000, "pending")
      } }), saleId
    ]);
    const result = (await persist(db, accountId, [snapshot("payment-1", "approved", 1000, "pending")])).rows[0].result;
    const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
    assert.equal(isoTimestamp(row.data_liberacao), "2026-11-30T15:00:00.000Z");
    assert.equal(isoTimestamp(result.data_liberacao), isoTimestamp(row.data_liberacao));
    assert.equal(result.effective_release_at, null);
  } finally { await db.close(); }
});

for (const representation of ["payments_by_id", "payments"]) {
  test(`first GMUD2 delivery retains legacy pending sibling from ${representation}`, async () => {
    const db = await setup();
    try {
      const siblings = [snapshot("payment-1"), snapshot("payment-2", "pending", null, "pending")];
      const legacy = representation === "payments" ? { payments: siblings }
        : { payments_by_id: Object.fromEntries(siblings.map(payment => [payment.id, payment])) };
      await db.query(`update venda set raw_data=jsonb_set(raw_data,'{financial_capture}',$1::jsonb,true) where id=$2`, [JSON.stringify(legacy), saleId]);
      const result = (await persist(db, accountId, [snapshot("payment-1")], {
        expected: ["payment-1"], capture: { ...capture, order_payment_ids: ["payment-1"], order_api_updated_at: "2026-11-23T12:00:00Z" }
      })).rows[0].result;
      const row = (await db.query("select * from venda where id=$1", [saleId])).rows[0];
      assert.deepEqual(row.raw_data.financial_capture.order_payment_ids, expectedIds);
      assert.equal(row.raw_data.financial_capture.payments_by_id["payment-2"].status, "pending");
      assert.equal(row.raw_data.financial_capture.effective_release_at, undefined);
      assert.equal(row.data_liberacao, null);
      assert.equal(result.effective_release_at, null);
      assert.equal(result.commercial_net_updated, false);
      assert.equal(row.valor_liquido, "23.50");
    } finally { await db.close(); }
  });
}
