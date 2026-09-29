import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  MarketplaceNotificationCursor,
  NotificationCursorPosition,
  initialMarketplaceNotificationCursor,
  parseMarketplaceNotificationCursor,
  validTimestamp
} from "@/lib/global-marketplace-notifications";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  const checkedAt = new Date().toISOString();
  const cursorValue = request.nextUrl.searchParams.get("cursor");
  if (!cursorValue) {
    return NextResponse.json({
      cursor: initialMarketplaceNotificationCursor(checkedAt), notifications: [], hasMore: false, until: checkedAt
    }, { headers: { "cache-control": "no-store" } });
  }

  const cursor = parseMarketplaceNotificationCursor(cursorValue);
  const requestedUntil = request.nextUrl.searchParams.get("until");
  const until = requestedUntil && validTimestamp(requestedUntil) ? requestedUntil : checkedAt;
  if (!cursor) return NextResponse.json({ error: "Cursor incremental inválido." }, { status: 400 });

  const db = supabaseAdmin();
  const [salesResult, messagesResult] = await Promise.all([
    afterPosition(db.from("venda")
      .select("id,marketplace,data_venda,created_at,venda_item(sku)"), cursor.sales)
      .lte("created_at", until).order("created_at").order("id").limit(PAGE_SIZE + 1),
    afterPosition(db.from("marketplace_conversation_messages")
      .select("id,text,sent_at,created_at,conversation_id,marketplace_conversations(marketplace,buyer_name,buyer_id,conversation_type)")
      .eq("direction", "incoming"), cursor.messages)
      .lte("created_at", until).order("created_at").order("id").limit(PAGE_SIZE + 1)
  ]);

  if (salesResult.error || messagesResult.error) {
    console.error("[global_notifications]", salesResult.error || messagesResult.error);
    return NextResponse.json({ error: "Não foi possível consultar as notificações." }, { status: 500 });
  }

  const saleBatch = takePage((salesResult.data || []) as any[]);
  const messageBatch = takePage((messagesResult.data || []) as any[]);
  const skus = [...new Set(saleBatch.rows.flatMap(sale =>
    (sale.venda_item || []).map((item: any) => String(item.sku || "")).filter(Boolean)))];
  const productsResult = skus.length
    ? await db.from("products").select("sku,title").in("sku", skus)
    : { data: [], error: null };
  if (productsResult.error) console.error("[global_notifications_products]", productsResult.error);
  const titles = new Map((productsResult.data || []).map(product => [normalizeSku(product.sku), String(product.title || "")]));

  const sales = saleBatch.rows.map(sale => {
    const items = (sale.venda_item || []) as Array<{ sku?: string }>;
    const descriptions = items.map(item => titles.get(normalizeSku(item.sku)) || String(item.sku || "Item")).filter(Boolean);
    const occurredAt = sale.data_venda || sale.created_at;
    return {
      id: `sale:${sale.id}`, kind: "sale" as const, marketplace: sale.marketplace,
      title: `Nova venda - ${formatDateTime(occurredAt)}`,
      description: descriptions.join(" + ") || "Novo item vendido",
      occurredAt, href: "/vendas"
    };
  });

  const messages = messageBatch.rows.map(message => {
    const conversation = Array.isArray(message.marketplace_conversations)
      ? message.marketplace_conversations[0] : message.marketplace_conversations;
    const customer = String(conversation?.buyer_name
      || (conversation?.buyer_id ? `Cliente ${mask(String(conversation.buyer_id))}` : "Cliente não identificado"));
    return {
      id: `message:${message.id}`, kind: "message" as const, marketplace: conversation?.marketplace,
      title: conversation?.conversation_type === "question" ? "Nova Pergunta" : "Novo Chat",
      customer, description: String(message.text || "Nova mensagem recebida"),
      occurredAt: message.sent_at || message.created_at, href: "/chats-perguntas"
    };
  }).filter(item => item.marketplace === "mercado_livre" || item.marketplace === "shopee");

  const nextCursor: MarketplaceNotificationCursor = {
    sales: nextPosition(cursor.sales, saleBatch.rows, saleBatch.hasMore, until),
    messages: nextPosition(cursor.messages, messageBatch.rows, messageBatch.hasMore, until)
  };
  return NextResponse.json({
    cursor: nextCursor,
    notifications: [...sales, ...messages].sort((left, right) =>
      new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()),
    hasMore: saleBatch.hasMore || messageBatch.hasMore,
    until
  }, { headers: { "cache-control": "no-store" } });
}

function afterPosition(query: any, position: NotificationCursorPosition) {
  if (!position.id) return query.gt("created_at", position.createdAt);
  return query.or(`created_at.gt.${position.createdAt},and(created_at.eq.${position.createdAt},id.gt.${position.id})`);
}

function takePage<T>(rows: T[]) {
  return { rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

function nextPosition(previous: NotificationCursorPosition, rows: any[], hasMore: boolean, until: string) {
  if (!hasMore) return { createdAt: until, id: "" };
  const last = rows[rows.length - 1];
  return last ? { createdAt: String(last.created_at), id: String(last.id) } : previous;
}

function normalizeSku(value: unknown) { return String(value || "").trim().toLocaleUpperCase("pt-BR"); }
function mask(value: string) { return value.length <= 4 ? value : `${value.slice(0, 2)}•••${value.slice(-2)}`; }
function formatDateTime(value: string) {
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)?.value || "";
  return `${part("day")}/${part("month")} - ${part("hour")}:${part("minute")}:${part("second")}`;
}
