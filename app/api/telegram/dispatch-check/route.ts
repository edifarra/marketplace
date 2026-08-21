import { NextRequest, NextResponse } from "next/server";
import { runPendingDispatchJob } from "@/lib/telegram-notifications";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.SUPABASE_CRON_SECRET;
  if (!secret || request.headers.get("x-supabase-cron-secret") !== secret) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }
  try { return NextResponse.json(await runPendingDispatchJob()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
