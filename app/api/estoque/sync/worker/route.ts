import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getTinyStockSyncProgress } from "@/lib/tiny-stock-sync";
import { runTinyStockSyncWorker } from "@/lib/tiny-stock-sync-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.AUTH_SESSION_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Acesso nao autorizado." }, { status: 401 });
  }

  const progress = await getTinyStockSyncProgress();
  if (progress.status === "running") {
    waitUntil(runTinyStockSyncWorker(request.nextUrl.origin));
  }

  return NextResponse.json({ accepted: progress.status === "running", progress });
}
