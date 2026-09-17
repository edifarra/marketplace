import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = String(request.nextUrl.searchParams.get("id") || "");
  if (!id) return NextResponse.json({ error: "Atividade não informada." }, { status: 400 });
  const result = await supabaseAdmin().from("marketplace_activities")
    .select("id,status,processing_error,processed_at")
    .eq("id", id)
    .maybeSingle();
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  if (!result.data) return NextResponse.json({ error: "Atividade não encontrada." }, { status: 404 });
  return NextResponse.json({ activity: result.data }, { headers: { "cache-control": "no-store" } });
}
