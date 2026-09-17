import { NextRequest, NextResponse } from "next/server";
import { latestConversationCursor, takeConversationChangeBatch } from "@/lib/marketplace-conversation-delta";
import { prepareConversationRows } from "@/lib/marketplace-conversation-view";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  const requestedUpdatedAt = request.nextUrl.searchParams.get("after");
  const afterId = request.nextUrl.searchParams.get("afterId");
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Number.isFinite(requestedLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requestedLimit))) : DEFAULT_LIMIT;
  const safeTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(requestedUpdatedAt || "");
  const safeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(afterId || "")
    || afterId === "00000000-0000-0000-0000-000000000000";
  if (!requestedUpdatedAt || !afterId || !safeTimestamp || !safeId || !Number.isFinite(new Date(requestedUpdatedAt).getTime())) {
    return NextResponse.json({ error: "Cursor incremental inválido." }, { status: 400 });
  }
  // Preserva microssegundos retornados pelo Postgres; Date#toISOString os truncaria.
  const updatedAt = requestedUpdatedAt;

  try {
    const db = supabaseAdmin();
    const changedResult = await db.from("marketplace_conversations")
      .select("id,updated_at,marketplace,conversation_type,marketplace_account_id,buyer_id,buyer_name,sku,listing_id")
      .or(`updated_at.gt.${updatedAt},and(updated_at.eq.${updatedAt},id.gt.${afterId})`)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit + 1)
      .throwOnError();

    const batch = takeConversationChangeBatch(changedResult.data || [], limit);
    const changed = batch.rows;
    if (!changed.length) {
      return NextResponse.json({
        cursor: { updatedAt, id: afterId }, changes: [], changedConversationIds: [], hasMore: false
      }, { headers: { "cache-control": "no-store" } });
    }

    const affectedIds = new Set(changed.map((row) => String(row.id)));
    for (const row of changed) {
      if (row.marketplace !== "mercado_livre" || row.conversation_type !== "question") continue;
      let siblings = db.from("marketplace_conversations").select("id")
        .eq("marketplace", "mercado_livre")
        .eq("conversation_type", "question")
        .eq("marketplace_account_id", row.marketplace_account_id);
      siblings = row.buyer_id
        ? siblings.eq("buyer_id", row.buyer_id)
        : row.buyer_name
          ? siblings.is("buyer_id", null).eq("buyer_name", row.buyer_name)
          : siblings.is("buyer_id", null).is("buyer_name", null);
      siblings = row.sku
        ? siblings.eq("sku", row.sku)
        : row.listing_id
          ? siblings.is("sku", null).eq("listing_id", row.listing_id)
          : siblings.is("sku", null).is("listing_id", null);
      const result = await siblings.throwOnError();
      for (const sibling of result.data || []) affectedIds.add(String(sibling.id));
    }

    const [conversations, settings] = await Promise.all([
      db.from("marketplace_conversations")
        .select("*,config_marketplace_accounts(name,nickname,shop_id),marketplace_conversation_messages(*)")
        .in("id", [...affectedIds])
        .throwOnError(),
      db.from("settings").select("key,value")
        .in("key", ["CHAT_SLA_WITH_PRODUCT_HOURS", "CHAT_SLA_WITHOUT_PRODUCT_HOURS"])
        .throwOnError()
    ]);
    const setting = (key: string, fallback: number) => {
      const value = settings.data?.find((row) => row.key === key)?.value;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const changes = prepareConversationRows(
      conversations.data || [],
      setting("CHAT_SLA_WITH_PRODUCT_HOURS", 1),
      setting("CHAT_SLA_WITHOUT_PRODUCT_HOURS", 6)
    );
    const cursor = latestConversationCursor(changed);
    return NextResponse.json({
      cursor,
      changes,
      changedConversationIds: changed.map((row) => String(row.id)),
      hasMore: batch.hasMore
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
