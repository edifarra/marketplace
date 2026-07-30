import { NextRequest, NextResponse } from "next/server";
import { getActiveShopeeAccounts } from "@/lib/shopee";
import { listRecentlyUpdatedShopeeOrders, processShopeeOrderSynchronized } from "@/lib/shopee-orders";
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
    const hours = Math.min(Math.max(Number(body.hours || request.nextUrl.searchParams.get("hours") || 72), 1), 360);
    const accounts = await getActiveShopeeAccounts();
    if (!accounts.length) return NextResponse.json({ error: "Nenhuma conta Shopee ativa encontrada." }, { status: 404 });

    // Inclui explicitamente as vendas presas em "Pronta para envio", mesmo que
    // a ultima mudanca na Shopee esteja fora da janela da consulta recente.
    const stale = await supabaseAdmin().from("venda")
      .select("order_id,raw_data,status_venda!inner(internal_status)")
      .eq("marketplace", "shopee")
      .eq("status_venda.internal_status", "pronta_para_envio")
      .limit(200)
      .throwOnError();
    const results: Array<Record<string, unknown>> = [];

    for (const account of accounts) {
      const refs = await listRecentlyUpdatedShopeeOrders(account, hours);
      const orderIds = new Set(refs.map((row) => String(row.order_sn || row.ordersn || "")).filter(Boolean));
      for (const sale of stale.data || []) {
        const raw = (sale.raw_data || {}) as Record<string, any>;
        const accountId = String(raw.marketplace_account_id || "");
        if (!accountId || accountId === account.id || accounts.length === 1) orderIds.add(String(sale.order_id));
      }
      const processed: Array<Record<string, unknown>> = [];
      for (const orderSn of orderIds) {
        try {
          processed.push({
            orderSn,
            ok: true,
            result: await processShopeeOrderSynchronized(orderSn, account, { recovery: true })
          });
        } catch (error) {
          processed.push({ orderSn, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      results.push({ account: account.name, recent: refs.length, processed });
    }
    return NextResponse.json({ accounts: results, staleReadyToShip: stale.data?.length || 0 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
