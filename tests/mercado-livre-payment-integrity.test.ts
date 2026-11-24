import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("payment completion writes order_id only after processor persistence and confirms the activity update", () => {
  const worker = readFileSync("lib/marketplace-queue-worker.ts", "utf8");
  const queue = readFileSync("lib/marketplace-queue.ts", "utf8");
  const processor = readFileSync("lib/mercado-livre-payment-webhook.ts", "utf8");
  assert.match(worker, /processMercadoLivrePaymentNotification\(payload[\s\S]*?completeQueuedActivity[\s\S]*?\{ topic, \.\.\.result \}/);
  assert.match(worker, /MercadoLivrePaymentIntegrityError[\s\S]*failQueuedActivity/);
  assert.match(worker, /isMercadoLivrePaymentsActivity\(activity\)[\s\S]*failQueuedActivity[\s\S]*retryQueuedActivity/);
  const failureHandler = queue.match(/export async function failQueuedActivity[\s\S]*?\n}/)?.[0] || "";
  assert.match(failureHandler, /status: "error"[\s\S]*processing_error: error\.message/);
  assert.doesNotMatch(failureHandler, /raw_payload|next_attempt_at/);
  assert.match(queue, /details\.orderId[\s\S]*order_id/);
  assert.match(queue, /select\("id"\)\.maybeSingle\(\)[\s\S]*processed nao confirmado/);
  assert.match(processor, /persist_mercado_livre_payment_finance[\s\S]*if \(!persisted\.data\?\.persisted\)/);
  assert.doesNotMatch(processor, /insert\(|upsert\(|estoque|inventory/i);
});

test("GMUD2 writes payment snapshots to financial tables and never mutates commercial sale fields", () => {
  const migration = readFileSync("supabase/migrations/20261123190000_separate_sale_and_payment_finance.sql", "utf8");
  const processor = readFileSync("lib/mercado-livre-payment-webhook.ts", "utf8");
  const inventory = readFileSync("lib/inventory.ts", "utf8");
  const orders = readFileSync("lib/mercado-livre-orders.ts", "utf8");
  assert.match(migration, /create table public\.marketplace_payment_finance\s*\(/i);
  assert.match(migration, /create table public\.marketplace_payment_finance_history\s*\(/i);
  assert.match(migration, /sale_id uuid references public\.venda\(id\)/i);
  assert.match(migration, /transaction_type text/);
  assert.doesNotMatch(migration, /update\s+public\.venda[\s\S]*?(?:valor_liquido|data_pagamento|data_liberacao)/i);
  assert.match(processor, /order_identifiers/);
  assert.match(processor, /saleLinkStatus/);
  assert.doesNotMatch(processor, /\.from\("venda"\)/);
  assert.doesNotMatch(inventory, /saleFinancialPatch|financialCapture|financialColumns/);
  assert.doesNotMatch(orders, /captureSaleFinance|api\.mercadopago\.com/);
});

test("reverse validation is allowlisted to the two approved ML-GI cases and never uses the general queue", () => {
  const source = readFileSync("scripts/validate-mercado-livre-payment-finance.ts", "utf8");
  for (const value of ["188648383926", "2000019431066286", "188470569542", "2000019408878278"]) assert.ok(source.includes(value));
  assert.match(source, /if \(!execute\)[\s\S]*read_only_preview/);
  assert.match(source, /processMercadoLivrePaymentNotification\(payload, account[\s\S]*target\.orderId/);
  assert.match(source, /readExistingSale[\s\S]*before[\s\S]*after/);
  assert.doesNotMatch(source, /processMarketplaceQueue|processMercadoLivreOrder|inventory|estoque|\.insert\(|\.upsert\(|\.update\(/i);
});

test("effective release persistence requires released status and a valid date, without webhook-time substitution", () => {
  const migration = readFileSync("supabase/migrations/20261122130000_persist_mercado_livre_release_date.sql", "utf8");
  assert.match(migration, /money_release_status' = 'released'/);
  assert.match(migration, /money_release_date'\) ~ '\(Z\|\[\+\-\]/);
  assert.match(migration, /data_liberacao = case[\s\S]*greatest\(data_liberacao, effective_release_at\)/i);
  assert.match(migration, /when effective_release_at is not null and previous_release_is_forecast then effective_release_at/i);
  assert.match(migration, /incoming_version > previous_version/);
  assert.match(migration, /for update/i);
  assert.doesNotMatch(migration, /data_liberacao\s*=\s*(?:now\(\)|current_timestamp)/i);
  assert.doesNotMatch(migration, /insert into public\.venda|update\s+public\.estoque/i);
});

test("current release reconciliation excludes only proven non-receipt attempts and preserves prior proof separately", () => {
  const migration = readFileSync("supabase/migrations/20261123130000_exclude_nonreceiving_ml_attempts_release.sql", "utf8");
  assert.match(migration, /status' in \('cancelled', 'rejected'\)/);
  assert.match(migration, /net_received_amount/);
  assert.match(migration, /transaction_amount_refunded/);
  assert.match(migration, /ambiguous_terminal_count > 0/);
  assert.match(migration, /current_expected_ids/);
  assert.match(migration, /incoming_order_version > previous_order_version/);
  assert.match(migration, /previous_effective_release_at/);
  assert.match(migration, /when current_effective_release_at is not null then greatest\(data_liberacao, current_effective_release_at\)/i);
  assert.match(migration, /create or replace function public\.persist_mercado_livre_payment_finance\(\s*p_marketplace_account_id uuid,[\s\S]*p_activity_id text\s*\) returns jsonb/i);
  assert.match(migration, /revoke all on function public\.persist_mercado_livre_payment_finance\(uuid, text, text, jsonb, jsonb, jsonb, boolean, text\)[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /data_liberacao\s*=\s*(?:now\(\)|current_timestamp)/i);
  assert.doesNotMatch(migration, /insert into public\.venda|update\s+public\.estoque/i);
});
