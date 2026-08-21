import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ids = String(request.nextUrl.searchParams.get("ids") || "").split(",").map(id => id.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length) return NextResponse.json({ error: "Atividades não informadas." }, { status: 400 });
  const result = await supabaseAdmin().from("outgoing_marketplace_activities")
    .select("id,status,processing_error,confirmed_data,updated_at").in("id", ids);
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  return NextResponse.json({ activities: result.data || [] }, { headers: { "cache-control": "no-store" } });
}
