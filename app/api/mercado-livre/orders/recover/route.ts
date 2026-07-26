import { NextRequest, NextResponse } from "next/server";
import { getActiveMercadoLivreAccounts, listRecentMercadoLivreOrders } from "@/lib/mercado-livre";
import { processMercadoLivreOrder } from "@/lib/mercado-livre-orders";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }

  try {
  const body = await request.json().catch(() => ({}));
  const accountName = String(body.account || "ML-ED").toLowerCase();
  const accounts = await getActiveMercadoLivreAccounts();
  const account = accounts.find((item) => item.name.toLowerCase() === accountName);
  if (!account) return NextResponse.json({ error: `Conta ${body.account || "ML-ED"} nao encontrada.` }, { status: 404 });

  const recent = await listRecentMercadoLivreOrders(account, Number(body.limit || 25));
  const pending = await supabaseAdmin().from("marketplace_activities")
    .select("order_id,raw_payload")
    .eq("marketplace", "mercado_livre").in("status", ["received", "error"])
    .not("order_id", "is", null).limit(50).throwOnError();
  const orderIds = new Set(recent.map((order) => String(order.id)));
  for (const row of pending.data || []) orderIds.add(String(row.order_id));

  const results: Array<Record<string, unknown>> = [];
  for (const orderId of orderIds) {
    try {
      results.push({ orderId, ok: true, result: await processMercadoLivreOrder(orderId, account, { topic: "orders_v2", recovery: true }) });
    } catch (error) {
      results.push({ orderId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return NextResponse.json({ account: account.name, recent: recent.length, pending: pending.data?.length || 0, processed: results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
