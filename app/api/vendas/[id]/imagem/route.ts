import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  getMercadoLivreAccountById,
  getMercadoLivreAccountForNotification,
  getValidMercadoLivreAccessToken
} from "@/lib/mercado-livre";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const sku = new URL(request.url).searchParams.get("sku")?.trim() || "";
    const { data: sale } = await supabaseAdmin().from("venda")
      .select("marketplace,raw_data").eq("id", params.id).single().throwOnError();

    const raw = (sale.raw_data || {}) as Record<string, any>;
    const sourceItem = findSourceItem(raw, sku);
    if (sale.marketplace === "shopee") {
      const shopeeImage = String(sourceItem?.image_info?.image_url || sourceItem?.image_info?.image_url_list?.[0] || "");
      if (shopeeImage) return proxyImage(shopeeImage);
    }
    if (sale.marketplace === "mercado_livre") {
      const itemId = String(sourceItem?.item?.id || sourceItem?.item_id || "");
      if (itemId) {
        const payload = (raw.payload || raw) as Record<string, any>;
        const accountId = String(raw.marketplace_account_id || "");
        const sellerId = payload.notification?.user_id || payload.order?.seller?.id;
        const account = accountId
          ? await getMercadoLivreAccountById(accountId)
          : await getMercadoLivreAccountForNotification(sellerId);
        const accessToken = await getValidMercadoLivreAccessToken(account);
        const response = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "force-cache"
        });
        if (response.ok) {
          const item = await response.json() as Record<string, any>;
          const mercadoLivreImage = String(item.pictures?.[0]?.secure_url || item.secure_thumbnail || item.thumbnail || "");
          if (mercadoLivreImage) return proxyImage(mercadoLivreImage);
        }
      }
    }
    return imagePlaceholder();
  } catch {
    return imagePlaceholder();
  }
}

function findSourceItem(raw: Record<string, any>, sku: string) {
  const payload = (raw.payload || raw) as Record<string, any>;
  const order = payload.order || {};
  const items = order.order_items || order.item_list || payload.items || payload.data?.items || payload.data?.item_list || [];
  if (!Array.isArray(items)) return null;
  const normalizedSku = sku.toLocaleUpperCase("pt-BR");
  return items.find((item: Record<string, any>) => {
    const itemSku = item.model_sku || item.item_sku || item.sku || item.item?.seller_sku || item.item?.seller_custom_field;
    return String(itemSku || "").trim().toLocaleUpperCase("pt-BR") === normalizedSku;
  }) || items[0] || null;
}

async function proxyImage(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return imagePlaceholder();
  const hostname = parsed.hostname.toLowerCase();
  const allowed = hostname === "cf.shopee.com.br"
    || hostname.endsWith(".shopee.com.br")
    || hostname === "http2.mlstatic.com"
    || hostname.endsWith(".mlstatic.com");
  if (!allowed) return imagePlaceholder();
  const response = await fetch(parsed, { cache: "force-cache" });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.startsWith("image/")) return imagePlaceholder();
  return new NextResponse(await response.arrayBuffer(), {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600, s-maxage=86400"
    }
  });
}

function imagePlaceholder() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="380" viewBox="0 0 380 380"><rect width="380" height="380" fill="#f8fafc"/><path d="M108 258l54-62 42 45 30-32 48 49H108z" fill="#cbd5e1"/><circle cx="145" cy="137" r="22" fill="#cbd5e1"/><text x="190" y="305" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#64748b">Sem foto</text></svg>`;
  return new NextResponse(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" }
  });
}
