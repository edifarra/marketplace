import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "DRIVE_COLLECT_PROGRESS")
    .maybeSingle();

  return NextResponse.json({
    progress: data?.value || {
      status: "idle",
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      message: "Aguardando execucao."
    }
  });
}
