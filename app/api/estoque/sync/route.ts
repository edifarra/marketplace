import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  getMarketplaceStockSyncProgress,
  startMarketplaceStockSync,
  stepMarketplaceStockSync
} from "@/lib/marketplace-stock-sync";
import { getTinyStockSyncProgress, startTinyStockSync, stepTinyStockSync } from "@/lib/tiny-stock-sync";
import { runTinyStockSyncWorker } from "@/lib/tiny-stock-sync-worker";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!await isAuthorized(request)) return NextResponse.json({ error: "Acesso nao autorizado." }, { status: 401 });
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  if (!accountId) {
    return NextResponse.json({ error: "Conta nao informada." }, { status: 400 });
  }

  return NextResponse.json({ progress: accountId === "tiny" ? await getTinyStockSyncProgress() : await getMarketplaceStockSyncProgress(accountId) });
}

export async function POST(request: NextRequest) {
  if (!await isAuthorized(request)) return NextResponse.json({ error: "Acesso nao autorizado." }, { status: 401 });
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  const action = request.nextUrl.searchParams.get("action") || "step";

  if (!accountId) {
    return NextResponse.json({ error: "Conta nao informada." }, { status: 400 });
  }

  const progress = accountId === "tiny"
    ? (action === "restart"
      ? await startTinyStockSync(true)
      : action === "start"
      ? await startTinyStockSync()
      : action === "resume"
        ? await getTinyStockSyncProgress()
        : await stepTinyStockSync())
    : (action === "start" ? await startMarketplaceStockSync(accountId) : await stepMarketplaceStockSync(accountId));

  if (accountId === "tiny" && progress.status === "running") {
    waitUntil(runTinyStockSyncWorker(request.nextUrl.origin));
  }

  return NextResponse.json({ progress });
}

async function isAuthorized(request: NextRequest) {
  const technicalSecret = process.env.AUTH_SESSION_SECRET || process.env.CRON_SECRET;
  if (technicalSecret && request.headers.get("authorization") === `Bearer ${technicalSecret}`) return true;
  return Boolean(await getCurrentUser());
}
