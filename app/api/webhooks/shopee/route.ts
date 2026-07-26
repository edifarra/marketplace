import { NextRequest, NextResponse } from "next/server";
import { registerMarketplaceSale } from "@/lib/inventory";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const order = payload.data || payload.response || payload;
  try {
    const shopId = String(payload.shop_id || order.shop_id || "");
    const account = shopId
      ? await supabaseAdmin().from("config_marketplace_accounts")
          .select("id,name,nickname").eq("marketplace", "shopee").eq("shop_id", shopId).maybeSingle()
      : { data: null };
    const result = await registerMarketplaceSale({
      marketplace: "shopee", externalEventId: String(payload.request_id || payload.event_id || ""),
      eventType: String(payload.code || payload.event || "notification"),
      externalOrderId: String(order.ordersn || order.order_sn || ""),
      externalListingId: order.item_id || order.items?.[0]?.item_id,
      status: String(order.order_status || order.status || "unknown"),
      items: (order.items || order.item_list || []).map((item: Record<string, any>) => ({
        sku: String(item.model_sku || item.item_sku || item.sku || ""), quantity: Number(item.model_quantity_purchased || item.quantity_purchased || 1),
        unitPrice: Number(item.model_discounted_price || item.discounted_price || 0)
      })),
      sku: String(order.item_sku || order.sku || ""), quantity: Number(order.quantity || 1),
      value: Number(order.total_amount || 0), shipping: Number(order.actual_shipping_fee || 0), shipmentId: String(order.package_number || ""), rawPayload: payload
      ,marketplaceAccountId: account.data?.id ? String(account.data.id) : undefined
      ,marketplaceNickname: String(account.data?.nickname || account.data?.name || "")
      ,soldAt: shopeeDate(order.create_time || order.create_time_timestamp)
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ accepted: true, processed: false, error: error instanceof Error ? error.message : String(error) }, { status: 202 });
  }
}

function shopeeDate(value: unknown) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
