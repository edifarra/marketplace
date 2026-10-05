import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sessão expirada." }, { status: 401 });
  const ids = (request.nextUrl.searchParams.get("ids") || "").split(",").filter(Boolean);
  if (!ids.length || ids.length > 25 || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id)))
    return NextResponse.json({ error: "Atividades inválidas." }, { status: 400 });
  try {
    const result = await supabaseAdmin().from("outgoing_marketplace_activities")
      .select("id,source_id,activity_type,status,processing_error")
      .in("id", ids).eq("destination", "shopee").eq("source_type", "marketplace_conversation")
      .in("activity_type", ["conversation_read", "conversation_delete"]).throwOnError();
    return NextResponse.json({ activities: result.data }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Não foi possível consultar o processamento dos chats." }, { status: 500 });
  }
}
