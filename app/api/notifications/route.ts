import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const checkedAt = new Date().toISOString();
  const after = request.nextUrl.searchParams.get("after");
  if (!after || !Number.isFinite(new Date(after).getTime())) {
    return NextResponse.json({ checkedAt, notifications: [] });
  }

  const db = supabaseAdmin();
  const [salesResult, messagesResult] = await Promise.all([
    db.from("venda").select("id,marketplace,data_venda,created_at,venda_item(sku)").gt("created_at", after).lte("created_at", checkedAt).order("created_at").limit(20),
    db.from("marketplace_conversation_messages")
      .select("id,text,sent_at,created_at,conversation_id,marketplace_conversations(marketplace,buyer_name,buyer_id,conversation_type)")
      .eq("direction", "incoming").gt("created_at", after).lte("created_at", checkedAt).order("created_at").limit(20)
  ]);

  if (salesResult.error || messagesResult.error) {
    console.error("[global_notifications]", salesResult.error || messagesResult.error);
    return NextResponse.json({ error: "Não foi possível consultar as notificações." }, { status: 500 });
  }

  const saleRows = (salesResult.data || []) as any[];
  const skus = [...new Set(saleRows.flatMap(sale => (sale.venda_item || []).map((item: any) => String(item.sku || "")).filter(Boolean)))];
  const productsResult = skus.length
    ? await db.from("products").select("sku,title").in("sku", skus)
    : { data: [], error: null };
  const titles = new Map((productsResult.data || []).map(product => [normalizeSku(product.sku), String(product.title || "")]));

  const sales = saleRows.map(sale => {
    const items = (sale.venda_item || []) as Array<{ sku?: string }>;
    const descriptions = items.map(item => titles.get(normalizeSku(item.sku)) || String(item.sku || "Item")).filter(Boolean);
    const occurredAt = sale.data_venda || sale.created_at;
    return {
      id: `sale:${sale.id}`, kind: "sale", marketplace: sale.marketplace,
      title: `Nova venda - ${formatDateTime(occurredAt)}`,
      description: descriptions.join(" + ") || "Novo item vendido",
      occurredAt, href: "/vendas"
    };
  });

  const messages = ((messagesResult.data || []) as any[]).map(message => {
    const conversation = Array.isArray(message.marketplace_conversations) ? message.marketplace_conversations[0] : message.marketplace_conversations;
    const customer = String(conversation?.buyer_name || (conversation?.buyer_id ? `Cliente ${mask(String(conversation.buyer_id))}` : "Cliente não identificado"));
    return {
      id: `message:${message.id}`, kind: "message", marketplace: conversation?.marketplace,
      title: conversation?.conversation_type === "question" ? "Nova Pergunta" : "Novo Chat",
      customer, description: String(message.text || "Nova mensagem recebida"),
      occurredAt: message.sent_at || message.created_at, href: "/chats-perguntas"
    };
  }).filter(item => item.marketplace === "mercado_livre" || item.marketplace === "shopee");

  return NextResponse.json({
    checkedAt,
    notifications: [...sales, ...messages].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
  });
}

function normalizeSku(value: unknown) { return String(value || "").trim().toLocaleUpperCase("pt-BR"); }
function mask(value: string) { return value.length <= 4 ? value : `${value.slice(0, 2)}•••${value.slice(-2)}`; }
function formatDateTime(value: string) {
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value || "";
  return `${part("day")}/${part("month")} - ${part("hour")}:${part("minute")}:${part("second")}`;
}
