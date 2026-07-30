import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { enqueueMarketplaceActivity, marketplaceEventId } from "@/lib/marketplace-queue";
import { processMarketplaceQueue } from "@/lib/marketplace-queue-worker";

export const maxDuration = 300;

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
  const code = Number(payload.code || 0);
  const orderIds = extractOrderSns(payload);
  try {
    await enqueueMarketplaceActivity({
      marketplace: "shopee",
      payload,
      eventType: String(payload.code || payload.event || "notification"),
      externalEventId: marketplaceEventId("shopee", payload),
      orderId: orderIds[0] || null,
      description: verifiedKey
        ? `Push Shopee ${code || "sem codigo"} enfileirado.`
        : "Push Shopee registrado com assinatura invalida.",
      sourceKey: verifiedKey || null,
      status: verifiedKey ? "queued" : "error",
      processingError: verifiedKey ? null : "Assinatura do Push Shopee invalida."
    });
  } catch (error) {
    console.error("[shopee_webhook_enqueue]", error);
    return new NextResponse(null, { status: 503 });
  }

  if (!verifiedKey) return new NextResponse(null, { status: 401 });
  waitUntil(processMarketplaceQueue(5).catch((error) => {
    console.error("[shopee_queue_worker]", error);
  }));
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
