import { NextRequest, NextResponse } from "next/server";
import { processPendingProductPrices } from "@/lib/price-processor";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) { return execute(request); }
export async function GET(request: NextRequest) { return execute(request); }

async function execute(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const dashboardAuthenticated = request.headers.get("x-dashboard-authenticated") === "1";
  if (!dashboardAuthenticated && (!process.env.CRON_SECRET || (secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET))) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }
  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") || 5);
    return NextResponse.json({ ok: true, ...(await processPendingProductPrices(limit)) });
  } catch (cause) {
    return NextResponse.json({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 });
  }
}
