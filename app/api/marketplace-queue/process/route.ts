import { NextRequest, NextResponse } from "next/server";
import { processMarketplaceQueue } from "@/lib/marketplace-queue-worker";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}

async function run(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }
  try {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const limit = Number(body.limit || request.nextUrl.searchParams.get("limit") || 10);
    return NextResponse.json(await processMarketplaceQueue(limit));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

