import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  getMarketplaceStockSyncProgress,
  startMarketplaceStockSync,
  stepMarketplaceStockSync
} from "@/lib/marketplace-stock-sync";
import { getTinyStockSyncProgress, startTinyStockSync, stepTinyStockSync } from "@/lib/tiny-stock-sync";
import { runTinyStockSyncWorker } from "@/lib/tiny-stock-sync-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  if (!accountId) {
    return NextResponse.json({ error: "Conta nao informada." }, { status: 400 });
  }

  return NextResponse.json({ progress: accountId === "tiny" ? await getTinyStockSyncProgress() : await getMarketplaceStockSyncProgress(accountId) });
}

export async function POST(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  const action = request.nextUrl.searchParams.get("action") || "step";

  if (!accountId) {
    return NextResponse.json({ error: "Conta nao informada." }, { status: 400 });
  }

  const progress = accountId === "tiny"
    ? (action === "start" ? await startTinyStockSync() : await stepTinyStockSync())
    : (action === "start" ? await startMarketplaceStockSync(accountId) : await stepMarketplaceStockSync(accountId));

  if (accountId === "tiny" && progress.status === "running") {
    waitUntil(runTinyStockSyncWorker(request.nextUrl.origin));
  }

  return NextResponse.json({ progress });
}
