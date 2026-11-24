import {
  getMercadoLivreOrder,
  getValidMercadoLivreAccessToken,
  MarketplaceAccountConfig
} from "./mercado-livre";
import { captureSaleFinance } from "./mercado-livre-sale-finance";
import { extractMercadoLivreSaleIdentifiers } from "./mercado-livre-sale-identifiers";
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
  let finance: Row;
  try {
    finance = await deps.capture(order, sellerId, async id => id === paymentId ? targetPayment : deps.readPayment(id, token));
  } catch {
    throw contextError("Captura financeira oficial falhou.", orderId);
  }
  if (!finance.payments.some((payment: Row) => String(payment.id) === paymentId)) {
    throw contextError("O pagamento notificado nao foi capturado; a atividade sera repetida.", orderId);
  }
  const officialIdentifiers = extractMercadoLivreSaleIdentifiers(order);
  for (const payment of finance.payments as Row[]) {
    for (const [identifierType, value] of [["SOURCE_ID", payment.source_id], ["OPERATION_ID", payment.operation_id]] as const) {
      if (value !== null && value !== undefined && String(value).trim()) {
        officialIdentifiers.push({ identifierType, identifierValue: String(value).trim() });
      }
    }
    for (const operation of Array.isArray(payment.operation_ids) ? payment.operation_ids : []) {
      const operationId = typeof operation === "string" || typeof operation === "number"
        ? String(operation).trim() : String(operation?.id || "").trim();
      if (operationId) officialIdentifiers.push({ identifierType: "OPERATION_ID", identifierValue: operationId });
    }
    for (const charge of Array.isArray(payment.charges) ? payment.charges as Row[] : []) {
      const chargeId = String(charge.id || "").trim();
      if (chargeId) officialIdentifiers.push({ identifierType: "CHARGE_ID", identifierValue: chargeId });
    }
  }
  const persistedCapture = {
    ...finance,
    official_order: {
      id: orderId,
      seller_id: sellerId,
      currency_id: order.currency_id,
      shipping_id: order.shipping?.id ?? order.shipping_id ?? null,
      pack_id: order.pack_id ?? order.pack?.id ?? null,
      payment_ids: expectedPaymentIds
    },
    order_identifiers: officialIdentifiers,
    original_references: {
      resource: payload.resource ?? null,
      notification_payment_id: paymentId,
      notification_topic: payload.topic ?? null,
      notification_action: payload.action ?? null,
      notification_payload: payload,
      official_order_reference: {
        order_id: orderId,
        shipping_id: order.shipping?.id ?? order.shipping_id ?? null,
        pack_id: order.pack_id ?? order.pack?.id ?? null
      }
    }
  };
  let persisted: any;
  try {
    persisted = await db.rpc("persist_mercado_livre_payment_finance", {
      p_marketplace_account_id: account.id,
      p_seller_id: sellerId,
      p_order_id: orderId,
      p_expected_payment_ids: expectedPaymentIds,
      p_payment_observations: finance.payments,
      p_financial_capture: persistedCapture,
      p_allow_net_update: finance.state === "complete" && finance.errors.length === 0,
      p_activity_id: activityId
    }).throwOnError();
  } catch {
    throw contextError("RPC de persistencia financeira falhou no Supabase.", orderId);
  }
  if (!persisted.data?.persisted) throw contextError("Persistencia financeira nao foi confirmada.", orderId);

  // Keep successfully captured sibling observations, but leave the event in
  // error for explicit review when any expected payment could not be refreshed.
  if (finance.errors.length) {
    throw contextError(`Captura financeira parcial; ${finance.errors.length} pagamento(s) aguardam nova tentativa.`, orderId);
  }
  return {
    orderId,
    paymentId,
    accountId: account.id,
    releaseStatus: targetPayment.money_release_status || null,
    predictedReleaseAt: targetPayment.money_release_status === "released" ? null : targetPayment.money_release_date || null,
    effectiveReleaseAt: finance.effective_release_at || null,
    saleId: persisted.data.sale_id || null,
    saleLinkStatus: persisted.data.sale_id ? "linked" : "pending",
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
