import { NextRequest, NextResponse } from "next/server";
import { getActiveMercadoLivreAccounts, listRecentMercadoLivreOrders } from "@/lib/mercado-livre";
import { processMercadoLivreOrder } from "@/lib/mercado-livre-orders";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return recoverOrders(request);
}

export async function POST(request: NextRequest) {
  return recoverOrders(request);
}

async function recoverOrders(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }

  try {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const requestedAccount = String(body.account || request.nextUrl.searchParams.get("account") || "").toLowerCase();
    const limit = Math.min(Math.max(Number(body.limit || request.nextUrl.searchParams.get("limit") || 25), 1), 50);
    const activeAccounts = await getActiveMercadoLivreAccounts();
    const accounts = requestedAccount
      ? activeAccounts.filter((item) => item.name.toLowerCase() === requestedAccount)
      : activeAccounts;
    if (!accounts.length) {
      return NextResponse.json({ error: requestedAccount ? `Conta ${requestedAccount} nao encontrada.` : "Nenhuma conta ativa encontrada." }, { status: 404 });
    }

    const pending = await supabaseAdmin().from("marketplace_activities")
      .select("order_id")
      .eq("marketplace", "mercado_livre").in("status", ["received", "error"])
      .not("order_id", "is", null).limit(50).throwOnError();
    const stale = await supabaseAdmin().from("venda")
      .select("order_id,raw_data,status_venda!inner(internal_status)")
      .eq("marketplace", "mercado_livre")
      .eq("status_venda.internal_status", "pronta_para_envio")
      .limit(200)
      .throwOnError();
    const accountResults: Array<Record<string, unknown>> = [];

    for (const account of accounts) {
      const recent = await listRecentMercadoLivreOrders(account, limit);
      const orderIds = new Set(recent.map((order) => String(order.id)));
      for (const row of pending.data || []) orderIds.add(String(row.order_id));
      for (const sale of stale.data || []) {
        const raw = (sale.raw_data || {}) as Record<string, any>;
        const accountId = String(raw.marketplace_account_id || "");
        if (!accountId || accountId === account.id || accounts.length === 1) orderIds.add(String(sale.order_id));
      }
      const processed: Array<Record<string, unknown>> = [];
      for (const orderId of orderIds) {
        try {
          processed.push({ orderId, ok: true, result: await processMercadoLivreOrder(orderId, account, { topic: "orders_v2", recovery: true }) });
        } catch (error) {
          processed.push({ orderId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      accountResults.push({ account: account.name, recent: recent.length, processed });
    }
    return NextResponse.json({ accounts: accountResults, pending: pending.data?.length || 0, staleReadyToShip: stale.data?.length || 0 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
