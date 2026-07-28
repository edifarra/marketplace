import { NextRequest, NextResponse } from "next/server";
import { processShopeeOrder } from "@/lib/shopee-orders";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const order = payload.data || payload.response || payload;
  try {
    const shopId = String(payload.shop_id || order.shop_id || "");
    const accountResult = shopId
      ? await supabaseAdmin().from("config_marketplace_accounts")
          .select("*").eq("marketplace", "shopee").eq("shop_id", shopId).maybeSingle()
      : { data: null };
    if (!accountResult.data) throw new Error(`Conta Shopee ${shopId || "nao informada"} nao encontrada.`);
    const orderSn = String(order.ordersn || order.order_sn || "");
    if (!orderSn) throw new Error("ID da venda Shopee nao encontrado na notificacao.");
    const result = await processShopeeOrder(orderSn, accountResult.data, payload, order);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    // Uma falha precisa ser reenviada pela Shopee; 202 confirmava e perdia o evento.
    return NextResponse.json({ accepted: false, processed: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
