import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

const account = "11111111-1111-4111-8111-111111111111";
const otherAccount = "22222222-2222-4222-8222-222222222222";
const sale = "33333333-3333-4333-8333-333333333333";
const otherSale = "44444444-4444-4444-8444-444444444444";
const now = "2026-11-23T12:00:00Z";
const ids = (...entries) => entries.map(([identifierType, identifierValue]) => ({ identifierType, identifierValue }));

async function setup() {
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table config_marketplace_accounts(id uuid primary key, marketplace text not null, seller_id text, account_id text);
    create table marketplace_activities(
      id uuid primary key default gen_random_uuid(), marketplace text not null, event_type text,
      raw_payload jsonb not null default '{}', status text not null, processing_error text,
      processed_at timestamptz, processing_started_at timestamptz, locked_at timestamptz,
      attempt_count integer not null default 0, next_attempt_at timestamptz not null default now(),
      received_at timestamptz not null default now()
    );
    create table venda(id uuid primary key, marketplace text not null, order_id text not null, raw_data jsonb not null default '{}',
      valor_liquido numeric(12,2) not null default 0, data_pagamento timestamptz, data_liberacao timestamptz, updated_at timestamptz);
    create table financial_statement_entries(id uuid primary key, account_id uuid, source text, semantic text, external_id text,
      payload_sha256 text, occurred_at timestamptz, unique(account_id,source,semantic,external_id,payload_sha256));
    insert into config_marketplace_accounts values
      ('${account}','mercado_livre','seller-ed','seller-ed'),('${otherAccount}','mercado_livre','seller-gi','seller-gi');
    insert into venda(id,marketplace,order_id,raw_data,valor_liquido,data_pagamento,data_liberacao) values
      ('${sale}','mercado_livre','order-1','{"marketplace_account_id":"${account}"}',14.43,'2026-11-20T12:00:00Z',null),
      ('${otherSale}','mercado_livre','order-2','{"marketplace_account_id":"${account}"}',15.79,null,null);`);
  await db.exec(readFileSync("supabase/migrations/20261123170000_create_sale_financial_identifiers.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20261123190000_separate_sale_and_payment_finance.sql", "utf8"));
  return db;
}

const observation = (id, overrides = {}) => ({
  id, status: "approved", currency_id: "BRL", observed_at: now, api_updated_at: now,
  date_approved: "2026-11-20T12:00:00Z", money_release_status: "pending",
  money_release_date: "2026-11-30T12:00:00Z", transaction_amount: 20,
  transaction_amount_refunded: 0, net_received_amount: 14.43, shipping_amount: 3.5,
  source_id: `source-${id}`, operation_id: `operation-${id}`, ...overrides
});
const capture = (orderId = "order-1", identifiers = ids(["ORDER_ID", orderId])) => ({
  official_order: { id: orderId, currency_id: "BRL", seller_id: "seller-ed" },
  order_identifiers: identifiers,
  original_references: { resource: `/collections/payment-${orderId}`, notification_payment_id: `payment-${orderId}` }
});
async function persist(db, { orderId = "order-1", accountId = account, seller = "seller-ed", payments = [observation(`payment-${orderId}`)], identifiers = ids(["ORDER_ID", orderId]), expected = payments.map(p => p.id), refs } = {}) {
  const result = await db.query(`select public.persist_mercado_livre_payment_finance(
    $1::uuid,$2::text,$3::text,$4::jsonb,$5::jsonb,$6::jsonb,$7::boolean,$8::text) as result`, [
    accountId, seller, orderId, JSON.stringify(expected), JSON.stringify(payments),
    JSON.stringify({ ...capture(orderId, identifiers), ...(refs ? { original_references: refs } : {}) }), true, "activity"
  ]);
  return result.rows[0].result;
}

test("preserves sale values and supports a pending link without creating a sale", async () => {
  const db = await setup();
  try {
    const pending = await persist(db, { orderId: "order-missing", identifiers: ids(["ORDER_ID", "order-missing"]) });
    assert.equal(pending.sale_id, null);
    assert.equal(pending.link_status, "pending");
    assert.equal((await db.query("select count(*)::int n from venda where order_id='order-missing'")).rows[0].n, 0);
    const saleRow = (await db.query("select valor_liquido,data_pagamento,data_liberacao from venda where id=$1", [sale])).rows[0];
    assert.equal(saleRow.valor_liquido, "14.43");
    assert.equal(new Date(saleRow.data_pagamento).toISOString(), "2026-11-20T12:00:00.000Z");
    assert.equal(saleRow.data_liberacao, null);
  } finally { await db.close(); }
});

test("links by official identifiers, but shared identifiers remain ambiguous", async () => {
  const db = await setup();
  try {
    await db.query("select persist_sale_financial_identifiers($1,$2,$3,$4)", [sale, account, "orders", JSON.stringify(ids(["PAYMENT_ID", "shared-payment"]))]);
    await db.query("select persist_sale_financial_identifiers($1,$2,$3,$4)", [otherSale, account, "orders", JSON.stringify(ids(["PAYMENT_ID", "shared-payment"]))]);
    const linked = await persist(db, { orderId: "order-1", identifiers: ids(["ORDER_ID", "order-1"], ["PAYMENT_ID", "unique-payment"], ["SHIPPING_ID", "ship-1"], ["PACK_ID", "pack-1"]) });
    assert.equal(linked.sale_id, sale);
    const savedIdentifiers = (await db.query("select identifier_type,identifier_value from venda_financeiro_identificadores where venda_id=$1", [sale])).rows;
    for (const identifier of [["PAYMENT_ID", "unique-payment"], ["SHIPPING_ID", "ship-1"], ["PACK_ID", "pack-1"]]) {
      assert.ok(savedIdentifiers.some(row => row.identifier_type === identifier[0] && row.identifier_value === identifier[1]));
    }
    const ambiguous = await persist(db, { orderId: "order-shared", identifiers: ids(["PAYMENT_ID", "shared-payment"]) });
    assert.equal(ambiguous.sale_id, null);
    assert.equal(ambiguous.link_status, "pending");
  } finally { await db.close(); }
});

test("multiple payments and duplicate webhook deliveries are idempotent; later divergence preserves history", async () => {
  const db = await setup();
  try {
    const payments = [observation("payment-a"), observation("payment-b", { transaction_amount: 30 })];
    await persist(db, { payments, refs: { resource: "/collections/first-reference", notification_payment_id: "payment-a" } });
    await persist(db, { payments });
    assert.equal((await db.query("select count(*)::int n from marketplace_payment_finance")).rows[0].n, 2);
    assert.equal((await db.query("select count(*)::int n from marketplace_payment_finance_history")).rows[0].n, 2);
    assert.equal((await db.query("select source_activity_id from marketplace_payment_finance where payment_id='payment-a'")).rows[0].source_activity_id, "activity");
    await persist(db, { payments: [observation("payment-a", { status: "refunded", transaction_amount_refunded: 20, api_updated_at: "2026-11-24T12:00:00Z" })], refs: { resource: "/collections/later-reference", notification_payment_id: "payment-a" } });
    assert.equal((await db.query("select status from marketplace_payment_finance where payment_id='payment-a'")).rows[0].status, "refunded");
    assert.equal((await db.query("select count(*)::int n from marketplace_payment_finance_history where payment_id='payment-a'")).rows[0].n, 2);
    const referenceHistory = (await db.query("select original_references->'reference_history' refs from marketplace_payment_finance where payment_id='payment-a'")).rows[0].refs;
    assert.ok(referenceHistory.some(ref => ref.resource === "/collections/first-reference"));
    assert.ok(referenceHistory.some(ref => ref.resource === "/collections/later-reference"));
    assert.equal((await db.query("select count(*)::int n from financial_statement_entries")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("financial records are account scoped and SOURCE_ID allows distinct official transaction types", async () => {
  const db = await setup();
  try {
    await persist(db, { orderId: "order-1", payments: [observation("same-payment")] });
    await persist(db, { orderId: "order-2", accountId: otherAccount, seller: "seller-gi", payments: [observation("same-payment")] });
    assert.equal((await db.query("select count(*)::int n from marketplace_payment_finance where payment_id='same-payment'")).rows[0].n, 2);
    for (const transactionType of ["SETTLEMENT", "DISPUTE", "REFUND", null]) {
      await db.query("insert into financial_statement_entries(id,account_id,source,semantic,external_id,payload_sha256,transaction_type) values(gen_random_uuid(),$1,'ml','movement','same-source','same-hash',$2)", [account, transactionType]);
    }
    assert.equal((await db.query("select count(*)::int n from financial_statement_entries where external_id='same-source'")).rows[0].n, 4);
  } finally { await db.close(); }
});

test("validation failure rolls back identifier and financial writes atomically", async () => {
  const db = await setup();
  try {
    await assert.rejects(persist(db, { orderId: "order-1", identifiers: ids(["ORDER_ID", "order-1"], ["PAYMENT_ID", ""]) }));
    assert.equal((await db.query("select count(*)::int n from marketplace_payment_finance")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from marketplace_payment_finance_history")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from venda_financeiro_identificadores")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("statement movement uniqueness includes transaction_type and NULL is supported", async () => {
  const sql = readFileSync("supabase/migrations/20261123190000_separate_sale_and_payment_finance.sql", "utf8");
  const importer = readFileSync("scripts/import-financial-october-2026.mjs", "utf8");
  assert.match(sql, /transaction_type text/);
  assert.match(sql, /unique nulls not distinct \(account_id, source, semantic, external_id, transaction_type, payload_sha256\)/i);
  assert.match(sql, /SETTLEMENT|DISPUTE|REFUND|CASHBACK/);
  assert.doesNotMatch(sql, /unique\s*\([^)]*external_id\s*\)/i);
  assert.match(importer,/transaction_type:\s*source === 'mp_settlement_report' && typeof payload\.TRANSACTION_TYPE === 'string' \? payload\.TRANSACTION_TYPE : null/);
  assert.match(importer,/onConflict:\s*'account_id,source,semantic,external_id,transaction_type,payload_sha256'/);
});

test("financial finance tables are service-only and the persistence RPC is not public", async () => {
  const db = await setup();
  try {
    for (const table of ["marketplace_payment_finance", "marketplace_payment_finance_history"]) {
      const security = (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where relname=$1", [table])).rows[0];
      assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true });
      assert.equal((await db.query("select has_table_privilege('anon',$1,'select') allowed", [table])).rows[0].allowed, false);
      assert.equal((await db.query("select has_table_privilege('authenticated',$1,'select') allowed", [table])).rows[0].allowed, false);
      assert.equal((await db.query("select has_table_privilege('service_role',$1,'select') allowed", [table])).rows[0].allowed, true);
      assert.equal((await db.query("select has_table_privilege('service_role',$1,'insert') allowed", [table])).rows[0].allowed, false);
    }
    const fn = (await db.query("select prosecdef from pg_proc where proname='persist_mercado_livre_payment_finance'")).rows[0];
    assert.equal(fn.prosecdef, true);
    assert.equal((await db.query("select has_function_privilege('anon','persist_mercado_livre_payment_finance(uuid,text,text,jsonb,jsonb,jsonb,boolean,text)','execute') allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege('service_role','persist_mercado_livre_payment_finance(uuid,text,text,jsonb,jsonb,jsonb,boolean,text)','execute') allowed")).rows[0].allowed, true);
  } finally { await db.close(); }
});

test("claim marks stale payments as errors and keeps stale non-payments retryable", async () => {
  const db = await setup();
  try {
    const paymentActivity = "55555555-5555-4555-8555-555555555555";
    const orderActivity = "66666666-6666-4666-8666-666666666666";
    await db.query(`insert into marketplace_activities(id,marketplace,event_type,raw_payload,status,locked_at,next_attempt_at)
      values ($1,'mercado_livre','notification',$2::jsonb,'processing',now()-interval '11 minutes',now()-interval '11 minutes'),
             ($3,'mercado_livre','notification',$4::jsonb,'processing',now()-interval '11 minutes',now()-interval '11 minutes')`, [
      paymentActivity, JSON.stringify({ topic: "payments", resource: "/collections/123" }),
      orderActivity, JSON.stringify({ topic: "orders_v2", resource: "/orders/456" })
    ]);
    const claimed = await db.query("select id from public.claim_marketplace_activity_queue(10)");
    assert.deepEqual(claimed.rows.map(row => row.id), [orderActivity]);
    const payment = (await db.query("select status,processing_error,locked_at from marketplace_activities where id=$1", [paymentActivity])).rows[0];
    assert.equal(payment.status, "error");
    assert.match(payment.processing_error, /ação explícita/i);
    assert.equal(payment.locked_at, null);
    const order = (await db.query("select status,attempt_count from marketplace_activities where id=$1", [orderActivity])).rows[0];
    assert.equal(order.status, "processing");
    assert.equal(order.attempt_count, 1);
  } finally { await db.close(); }
});
