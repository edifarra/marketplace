import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { processShopeeOrderSynchronized } from "@/lib/shopee-orders";
import { supabaseAdmin } from "@/lib/supabase-admin";

const ORDER_PUSH_CODES = new Set([3, 4, 15, 29, 30, 37, 47]);
const ACCOUNT_PUSH_CODES = new Set([1, 2, 12]);

export async function GET() {
  return NextResponse.json({ ok: true, marketplace: "shopee" });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  let payload: Record<string, any>;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const signature = request.headers.get("authorization") || "";
  const verifiedKey = verifyPushSignature(callbackUrl(request), rawBody, signature);
  if (!verifiedKey) {
    await logShopeeNotification(payload, "error", null, "Assinatura do Push Shopee invalida.");
    return new NextResponse(null, { status: 401 });
  }

  const code = Number(payload.code || 0);
  if (isVerificationPush(payload)) {
    await logShopeeNotification(payload, "processed", null, "Teste de callback Shopee validado.");
    return new NextResponse(null, { status: 204 });
  }

  const shopId = String(payload.shop_id || payload.data?.shop_id || "");
  const accountResult = shopId
    ? await supabaseAdmin().from("config_marketplace_accounts")
        .select("*").eq("marketplace", "shopee").eq("shop_id", shopId).maybeSingle()
    : { data: null, error: null };
  if (accountResult.error) {
    return await webhookFailure(payload, null, accountResult.error.message);
  }
  const account = accountResult.data;

  if (account && !signatureMatchesAccount(verifiedKey, String(account.name || ""))) {
    await logShopeeNotification(payload, "error", null, `Chave Push nao corresponde a loja ${account.name}.`);
    return new NextResponse(null, { status: 401 });
  }

  if (ACCOUNT_PUSH_CODES.has(code)) {
    if (!account) return await webhookFailure(payload, null, `Conta Shopee ${shopId || "nao informada"} nao encontrada.`);
    await processAccountPush(code, account.id, payload);
    return new NextResponse(null, { status: 204 });
  }

  const orderSns = await resolveOrderSns(payload);
  if (ORDER_PUSH_CODES.has(code) && orderSns.length) {
    if (!account) return await webhookFailure(payload, orderSns[0], `Conta Shopee ${shopId || "nao informada"} nao encontrada.`);
    try {
      for (const orderSn of orderSns) {
        await processShopeeOrderSynchronized(orderSn, account, payload);
      }
      return new NextResponse(null, { status: 204 });
    } catch (error) {
      return await webhookFailure(payload, orderSns[0], error instanceof Error ? error.message : String(error));
    }
  }

  await logShopeeNotification(
    payload,
    "processed",
    orderSns[0] || null,
    ORDER_PUSH_CODES.has(code)
      ? `Push Shopee ${code} reconhecido sem pedido identificavel.`
      : `Push Shopee ${code || "sem codigo"} reconhecido; nao altera vendas.`
  );
  return new NextResponse(null, { status: 204 });
}

function callbackUrl(request: NextRequest) {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}

function verifyPushSignature(callback: string, rawBody: string, authorization: string) {
  const keys = [
    ["ED", process.env.SHOPEE_PUSH_PARTNER_KEY_ED],
    ["GI", process.env.SHOPEE_PUSH_PARTNER_KEY_GI]
  ] as const;
  for (const [name, key] of keys) {
    if (!key) continue;
    const expected = createHmac("sha256", key).update(`${callback}|${rawBody}`).digest("hex");
    if (safeEqualHex(expected, authorization.trim())) return name;
  }
  return "";
}

function safeEqualHex(expected: string, received: string) {
  if (!/^[a-f0-9]+$/i.test(received)) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function signatureMatchesAccount(keyName: string, accountName: string) {
  const normalized = accountName.toUpperCase();
  if (normalized.includes("SP-ED")) return keyName === "ED";
  if (normalized.includes("SP-GI")) return keyName === "GI";
  return true;
}

function isVerificationPush(payload: Record<string, any>) {
  const code = String(payload.code ?? "").toLowerCase();
  return !payload.shop_id && ["", "0", "test", "verification"].includes(code);
}

function extractOrderSns(payload: Record<string, any>) {
  const found = new Set<string>();
  visit(payload.data || payload.response || payload, 0);
  return [...found];

  function visit(value: unknown, depth: number) {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (["ordersn", "order_sn"].includes(key.toLowerCase())) {
        const orderSn = String(entry || "").trim();
        if (orderSn) found.add(orderSn);
      } else if (["order_sn_list", "ordersn_list"].includes(key.toLowerCase()) && Array.isArray(entry)) {
        for (const item of entry) {
          const orderSn = String(item || "").trim();
          if (orderSn) found.add(orderSn);
        }
      } else {
        visit(entry, depth + 1);
      }
    }
  }
}

async function resolveOrderSns(payload: Record<string, any>) {
  const orderSns = new Set(extractOrderSns(payload));
  if (orderSns.size) return [...orderSns];

  const packageNumbers = extractValues(payload.data || payload, ["package_number", "package_no"]);
  if (!packageNumbers.length) return [];
  const { data, error } = await supabaseAdmin()
    .from("venda")
    .select("order_id")
    .eq("marketplace", "shopee")
    .in("shipment_id", packageNumbers);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    const orderSn = String(row.order_id || "").trim();
    if (orderSn) orderSns.add(orderSn);
  }
  return [...orderSns];
}

function extractValues(source: unknown, wantedKeys: string[]) {
  const found = new Set<string>();
  visit(source, 0);
  return [...found];

  function visit(value: unknown, depth: number) {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (wantedKeys.includes(key.toLowerCase())) {
        const normalized = String(entry || "").trim();
        if (normalized) found.add(normalized);
      } else {
        visit(entry, depth + 1);
      }
    }
  }
}

async function processAccountPush(code: number, accountId: string, payload: Record<string, any>) {
  const now = new Date().toISOString();
  const update = code === 2
    ? { status: "disconnected", last_error: "Autorizacao Shopee cancelada.", updated_at: now }
    : code === 12
      ? { last_error: "A Shopee informou que a autorizacao expirara em breve.", updated_at: now }
      : { status: "active", last_error: null, updated_at: now };
  const result = await supabaseAdmin().from("config_marketplace_accounts").update(update).eq("id", accountId);
  if (result.error) throw new Error(result.error.message);
  await logShopeeNotification(payload, "processed", null, `Push de autorizacao Shopee ${code} processado.`);
}

async function webhookFailure(payload: Record<string, any>, orderId: string | null, message: string) {
  await logShopeeNotification(payload, "error", orderId, message);
  return NextResponse.json({ accepted: false, processed: false, error: message }, { status: 500 });
}

async function logShopeeNotification(
  payload: Record<string, any>,
  status: "processed" | "error",
  orderId: string | null,
  message: string
) {
  try {
    const eventId = String(
      payload.request_id
      || payload.event_id
      || `shopee:${payload.code || "notification"}:${orderId || "no-order"}:${payload.timestamp || payload.update_time || Date.now()}`
    );
    const result = await supabaseAdmin().from("marketplace_activities").insert({
      marketplace: "shopee",
      event_type: String(payload.code || payload.event || "notification"),
      external_event_id: eventId,
      order_id: orderId,
      description: message,
      status,
      raw_payload: payload,
      processing_error: status === "error" ? message : null,
      processed_at: new Date().toISOString()
    });
    if (result.error && !/duplicate|unique/i.test(result.error.message)) {
      console.error("[shopee_webhook_log]", result.error);
    }
  } catch (error) {
    console.error("[shopee_webhook_log]", error);
  }
}
