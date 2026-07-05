import { NextRequest, NextResponse } from "next/server";
import {
  getMarketplaceStockSyncProgress,
  startMarketplaceStockSync,
  stepMarketplaceStockSync
} from "@/lib/marketplace-stock-sync";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  if (!accountId) {
    return NextResponse.json({ error: "Conta nao informada." }, { status: 400 });
  }

  return NextResponse.json({ progress: await getMarketplaceStockSyncProgress(accountId) });
}

export async function POST(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  const action = request.nextUrl.searchParams.get("action") || "step";

  if (!accountId) {
    return NextResponse.json({ error: "Conta nao informada." }, { status: 400 });
  }

  const progress = action === "start"
    ? await startMarketplaceStockSync(accountId)
    : await stepMarketplaceStockSync(accountId);

  return NextResponse.json({ progress });
}
