import { loadEnvConfig } from "@next/env";
import { getMercadoLivreAccountForNotification } from "../lib/mercado-livre";
import { completeQueuedActivity, failQueuedActivity } from "../lib/marketplace-queue";
import { paymentIdFromNotification, processMercadoLivrePaymentNotification } from "../lib/mercado-livre-payment-webhook";
import { supabaseAdmin } from "../lib/supabase-admin";

export const ML_GI_REVERSE_VALIDATION_CASES = [
  { activityId: "bfd499be-42ce-4054-a790-ca0bd077155e", paymentId: "188648383926", orderId: "2000019431066286" },
  { activityId: "22fae4cb-ad20-42c7-97b9-724464d70c35", paymentId: "188470569542", orderId: "2000019408878278" }
] as const;

function saleFinanceSnapshot(row: Record<string, any>, paymentId: string) {
  const capture = row.raw_data?.financial_capture || {};
  const payment = capture.payments_by_id?.[paymentId] || capture.payments?.find?.((item: Record<string, any>) => String(item.id) === paymentId) || null;
  return {
    sale_id: String(row.id), order_id: String(row.order_id), valor_liquido: row.valor_liquido,
    data_pagamento: row.data_pagamento, data_liberacao: row.data_liberacao,
    financial_capture_state: capture.state || null, commercial_net: capture.commercial_net ?? null,
    payment: payment ? {
      id: payment.id, status: payment.status, money_release_status: payment.money_release_status || null,
      money_release_date: payment.money_release_date || null, commercial_net_cents: payment.commercial_net_cents ?? null
    } : null
  };
}

async function readExistingSale(accountId: string, orderId: string, paymentId: string) {
  const response = await supabaseAdmin().from("venda")
    .select("id,order_id,valor_liquido,data_pagamento,data_liberacao,raw_data")
    .eq("marketplace", "mercado_livre").eq("order_id", orderId).throwOnError();
  const rows = (response.data || []) as Array<Record<string, any>>;
  const matches = rows.filter(row => String(row.raw_data?.marketplace_account_id || "") === accountId);
  if (matches.length !== 1) throw new Error(`A venda existente para ordem ${orderId} nao foi identificada de forma unica na conta ML-GI.`);
  return saleFinanceSnapshot(matches[0], paymentId);
}

async function run() {
  loadEnvConfig(process.cwd());
  const execute = process.argv.includes("--execute");
  const db = supabaseAdmin();
  const snapshots = [];
  for (const target of ML_GI_REVERSE_VALIDATION_CASES) {
    const response = await db.from("marketplace_activities")
      .select("id,marketplace,event_type,status,order_id,raw_payload")
      .eq("id", target.activityId).maybeSingle().throwOnError();
    const activity = response.data as Record<string, any> | null;
    if (!activity || activity.marketplace !== "mercado_livre" || activity.event_type !== "payments") {
      throw new Error(`Atividade alvo ausente ou nao e payments Mercado Livre: ${target.activityId}`);
    }
    const stored = activity.raw_payload || {};
    const payload = stored.notification || stored;
    if (paymentIdFromNotification(payload) !== target.paymentId) {
      throw new Error(`Atividade ${target.activityId} nao corresponde ao pagamento fixado ${target.paymentId}.`);
    }
    if (activity.order_id && String(activity.order_id) !== target.orderId) {
      throw new Error(`Atividade ${target.activityId} ja referencia outra ordem (${activity.order_id}).`);
    }
    const account = await getMercadoLivreAccountForNotification(payload.user_id);
    if (account.name !== "ML-GI") throw new Error(`Atividade alvo pertence a conta ${account.name}, nao ML-GI.`);
    const before = await readExistingSale(account.id, target.orderId, target.paymentId);
    snapshots.push({ target, activity, payload, account, before });
  }

  if (!execute) {
    console.log(JSON.stringify(snapshots.map(({ target, activity, before }) => ({
      activity_id: target.activityId,
      payment_id: target.paymentId,
      expected_order_id: target.orderId,
      current_status: activity.status,
      current_order_id: activity.order_id,
      before,
      mode: "read_only_preview"
    })), null, 2));
    return;
  }

  if (snapshots.some(({ activity }) => activity.status !== "processed")) {
    throw new Error("Validacao reversa cancelada: estado atual inesperado em uma das atividades alvo.");
  }

  // This explicit allowlist is intentionally independent of the general queue:
  // only the two approved activities can enter the official payment processor.
  for (const { target, activity, payload, account, before } of snapshots) {
    let accountName = "ML-GI";
    let sellerId = String(payload.user_id || "unknown");
    try {
      accountName = account.name;
      sellerId = String(account.seller_id || account.account_id || "unknown");
      const result = await processMercadoLivrePaymentNotification(payload, account, String(activity.id), {}, target.orderId);
      await completeQueuedActivity(String(activity.id), "Validacao reversa do pagamento Mercado Livre concluida.", {
        ...result, topic: "payments", reverseValidation: true, expectedOrderId: target.orderId
      });
      const after = await readExistingSale(account.id, target.orderId, target.paymentId);
      if (after.sale_id !== before.sale_id) throw new Error(`A identidade da venda alterou durante a validacao da ordem ${target.orderId}.`);
      console.log(JSON.stringify({ activity_id: target.activityId, payment_id: result.paymentId, order_id: result.orderId,
        finance_state: result.financeState, release_status: result.releaseStatus,
        effective_release_at: result.effectiveReleaseAt, persisted: result.persisted, before, after }));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await failQueuedActivity(String(activity.id), error, {
        accountName, sellerId, paymentId: target.paymentId, orderId: target.orderId, reverseValidation: true
      });
      throw error;
    }
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/validate-mercado-livre-payment-finance.ts")) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
