import {
  getMercadoLivreOrder,
  getValidMercadoLivreAccessToken,
  MarketplaceAccountConfig
} from "./mercado-livre";
import { captureSaleFinance } from "./mercado-livre-sale-finance";
import { supabaseAdmin } from "./supabase-admin";

type Row = Record<string, any>;
type PaymentProcessorDependencies = {
  getToken: typeof getValidMercadoLivreAccessToken;
  getOrder: typeof getMercadoLivreOrder;
  capture: typeof captureSaleFinance;
  database: typeof supabaseAdmin;
  readPayment: (id: string, token: string) => Promise<Row>;
};
const defaultDependencies: PaymentProcessorDependencies = {
  getToken: getValidMercadoLivreAccessToken,
  getOrder: getMercadoLivreOrder,
  capture: captureSaleFinance,
  database: supabaseAdmin,
  readPayment
};

export async function processMercadoLivrePaymentNotification(
  payload: Row,
  account: MarketplaceAccountConfig,
  activityId: string,
  dependencies: Partial<PaymentProcessorDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };
  const sellerId = String(account.seller_id || account.account_id || "").trim();
  if (!sellerId || String(payload.user_id || "").trim() !== sellerId) {
    throw new Error("Conta da notificacao de pagamento diverge da conta autorizada.");
  }
  const paymentId = paymentIdFromNotification(payload);
  if (!paymentId) throw new Error("ID do pagamento nao encontrado na notificacao Mercado Livre.");

  const token = await deps.getToken(account);
  const targetPayment = await deps.readPayment(paymentId, token);
  if (String(targetPayment.id) !== paymentId
    || String(targetPayment.collector_id) !== sellerId
    || targetPayment.order?.type !== "mercadolibre"
    || !/^\d+$/.test(String(targetPayment.order?.id || ""))
    || !targetPayment.currency_id) {
    throw new Error("Identidade do pagamento Mercado Livre divergente da conta autorizada.");
  }

  const orderId = String(targetPayment.order.id);
  const order = await deps.getOrder(orderId, account);
  if (String(order.id) !== orderId
    || String(order.currency_id) !== String(targetPayment.currency_id)
    || (order.seller?.id != null && String(order.seller.id) !== sellerId)) {
    throw new Error("Identidade do pedido Mercado Livre divergente do pagamento.");
  }
  const expectedPaymentIds = [...new Set<string>((order.payments || []).map((payment: Row) => String(payment.id || "")).filter(Boolean))];
  if (!expectedPaymentIds.includes(paymentId)) {
    throw new Error("O pagamento nao consta entre os pagamentos do pedido informado pela API.");
  }

  const db = deps.database();
  const saleResult = await db.from("venda")
    .select("id,raw_data,valor_liquido,data_pagamento")
    .eq("marketplace", "mercado_livre")
    .eq("order_id", orderId)
    .maybeSingle()
    .throwOnError();
  const sale = saleResult.data as Row | null;
  if (!sale) throw new Error(`Venda Mercado Livre ${orderId} ainda nao cadastrada; pagamento nao foi aplicado.`);
  const rawData = (sale.raw_data || {}) as Row;
  if (String(rawData.marketplace_account_id || "") !== String(account.id)) {
    throw new Error("A venda existente pertence a outra conta Mercado Livre ou nao tem conta verificavel.");
  }

  const finance = await deps.capture(order, sellerId, async id => id === paymentId ? targetPayment : deps.readPayment(id, token));
  if (!finance.payments.some(payment => String(payment.id) === paymentId)) {
    throw new Error("O pagamento notificado nao foi capturado; a atividade sera repetida.");
  }
  const persisted = await db.rpc("persist_mercado_livre_payment_finance", {
    p_marketplace_account_id: account.id,
    p_seller_id: sellerId,
    p_order_id: orderId,
    p_expected_payment_ids: expectedPaymentIds,
    p_payment_observations: finance.payments,
    p_financial_capture: finance,
    p_allow_net_update: finance.state === "complete" && finance.errors.length === 0,
    p_activity_id: activityId
  }).throwOnError();
  if (!persisted.data?.updated) throw new Error("A persistencia financeira nao confirmou a venda existente.");

  // Successful target persistence is not enough to mark the event complete if
  // a sibling payment could not be refreshed: a retry can safely merge again.
  if (finance.errors.length) {
    throw new Error(`Captura financeira parcial; ${finance.errors.length} pagamento(s) aguardam nova tentativa.`);
  }
  return {
    orderId,
    paymentId,
    accountId: account.id,
    releaseStatus: targetPayment.money_release_status || null,
    predictedReleaseAt: targetPayment.money_release_date || null,
    effectiveReleaseAt: null,
    financeState: finance.state,
    persisted: true
  };
}

export function paymentIdFromNotification(payload: Row) {
  const resource = String(payload.resource || "");
  const pathId = resource.match(/\/(?:collections|payments)\/(\d+)(?:[/?#]|$)/i)?.[1];
  const directId = payload.data?.id ?? payload.payment_id;
  const id = String(pathId || directId || "").trim();
  return /^\d+$/.test(id) ? id : "";
}

async function readPayment(id: string, token: string): Promise<Row> {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Consulta do pagamento Mercado Pago falhou (${response.status}).`);
  return response.json();
}
