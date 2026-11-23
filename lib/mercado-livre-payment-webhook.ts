import {
  getMercadoLivreOrder,
  getValidMercadoLivreAccessToken,
  MarketplaceAccountConfig
} from "./mercado-livre";
import { captureSaleFinance } from "./mercado-livre-sale-finance";
import { supabaseAdmin } from "./supabase-admin";

type Row = Record<string, any>;
export class MercadoLivrePaymentIntegrityError extends Error {
  readonly code = "mercado_livre_payment_integrity";
  constructor(message: string, readonly context: { accountId: string; accountName: string; sellerId: string; paymentId: string | null; orderId: string | null }) {
    super(`${message} [conta=${context.accountName}/${context.accountId}; seller=${context.sellerId}; pagamento=${context.paymentId || "nao identificado"}; ordem=${context.orderId || "nao identificada"}]`);
    this.name = "MercadoLivrePaymentIntegrityError";
  }
}
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
  dependencies: Partial<PaymentProcessorDependencies> = {},
  expectedOrderId?: string
) {
  const deps = { ...defaultDependencies, ...dependencies };
  const sellerId = String(account.seller_id || account.account_id || "").trim();
  const paymentId = paymentIdFromNotification(payload);
  if (!paymentId) throw new Error("ID do pagamento nao encontrado na notificacao Mercado Livre.");
  const integrityError = (message: string, orderId: string | null = null) => new MercadoLivrePaymentIntegrityError(message, {
    accountId: String(account.id), accountName: String(account.name), sellerId, paymentId, orderId
  });
  const contextError = (message: string, orderId: string | null = null) => new Error(`${message} [conta=${account.name}/${account.id}; seller=${sellerId}; pagamento=${paymentId}; ordem=${orderId || "nao identificada"}]`);
  if (!sellerId || String(payload.user_id || "").trim() !== sellerId) {
    throw integrityError("Conta da notificacao de pagamento diverge da conta autorizada.");
  }

  let token: string;
  let targetPayment: Row;
  try {
    token = await deps.getToken(account);
    targetPayment = await deps.readPayment(paymentId, token);
  } catch {
    throw contextError("Consulta do pagamento Mercado Pago falhou ou esta indisponivel.");
  }
  if (String(targetPayment.id) !== paymentId
    || String(targetPayment.collector_id) !== sellerId
    || targetPayment.order?.type !== "mercadolibre"
    || !/^\d+$/.test(String(targetPayment.order?.id || ""))
    || !targetPayment.currency_id) {
    throw integrityError("Identidade do pagamento Mercado Pago diverge da conta autorizada.");
  }

  const orderId = String(targetPayment.order.id);
  if (expectedOrderId && orderId !== expectedOrderId) {
    throw integrityError(`Pagamento aponta para ordem ${orderId}, diferente da ordem esperada ${expectedOrderId}.`, orderId);
  }
  let order: Row;
  try {
    order = await deps.getOrder(orderId, account);
  } catch {
    throw contextError("Consulta da ordem Mercado Livre falhou ou esta indisponivel.", orderId);
  }
  if (String(order.id) !== orderId
    || String(order.currency_id) !== String(targetPayment.currency_id)
    || String(order.seller?.id || "") !== sellerId) {
    throw integrityError("Identidade do pedido Mercado Livre diverge do pagamento ou da conta.", orderId);
  }
  const expectedPaymentIds = [...new Set<string>((order.payments || []).map((payment: Row) => String(payment.id || "")).filter(Boolean))];
  if (!expectedPaymentIds.includes(paymentId)) {
    throw integrityError("O pagamento nao consta entre os pagamentos da ordem informada pela API.", orderId);
  }

  const db = deps.database();
  let saleResult: any;
  try {
    saleResult = await db.from("venda")
      .select("id,raw_data,valor_liquido,data_pagamento")
      .eq("marketplace", "mercado_livre")
      .eq("order_id", orderId)
      .maybeSingle()
      .throwOnError();
  } catch {
    throw contextError("Consulta da venda existente no Supabase falhou.", orderId);
  }
  const sale = saleResult.data as Row | null;
  if (!sale) throw integrityError("Venda existente nao localizada; atualizacao financeira abortada sem criar venda.", orderId);
  const rawData = (sale.raw_data || {}) as Row;
  if (String(rawData.marketplace_account_id || "") !== String(account.id)) {
    throw integrityError("A venda localizada pertence a outra conta ou nao tem conta verificavel.", orderId);
  }

  let finance: Row;
  try {
    finance = await deps.capture(order, sellerId, async id => id === paymentId ? targetPayment : deps.readPayment(id, token));
  } catch {
    throw contextError("Captura financeira oficial falhou.", orderId);
  }
  if (!finance.payments.some((payment: Row) => String(payment.id) === paymentId)) {
    throw contextError("O pagamento notificado nao foi capturado; a atividade sera repetida.", orderId);
  }
  let persisted: any;
  try {
    persisted = await db.rpc("persist_mercado_livre_payment_finance", {
      p_marketplace_account_id: account.id,
      p_seller_id: sellerId,
      p_order_id: orderId,
      p_expected_payment_ids: expectedPaymentIds,
      p_payment_observations: finance.payments,
      p_financial_capture: finance,
      p_allow_net_update: finance.state === "complete" && finance.errors.length === 0,
      p_activity_id: activityId
    }).throwOnError();
  } catch {
    throw contextError("RPC de persistencia financeira falhou no Supabase.", orderId);
  }
  if (!persisted.data?.updated) throw contextError("Persistencia financeira da venda existente nao foi confirmada.", orderId);

  // Successful target persistence is not enough to mark the event complete if
  // a sibling payment could not be refreshed: a retry can safely merge again.
  if (finance.errors.length) {
    throw contextError(`Captura financeira parcial; ${finance.errors.length} pagamento(s) aguardam nova tentativa.`, orderId);
  }
  return {
    orderId,
    paymentId,
    accountId: account.id,
    releaseStatus: targetPayment.money_release_status || null,
    predictedReleaseAt: targetPayment.money_release_status === "released" ? null : targetPayment.money_release_date || null,
    effectiveReleaseAt: persisted.data.effective_release_at || null,
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
