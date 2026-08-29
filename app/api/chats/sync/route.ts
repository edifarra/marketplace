import { NextRequest, NextResponse } from "next/server";
import { syncAllMarketplaceConversations } from "@/lib/marketplace-conversations";
import { processOutgoingActivities } from "@/lib/outgoing-activities";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }
  try {
    const [sync, outgoing] = await Promise.all([syncAllMarketplaceConversations(), processOutgoingActivities(50)]);
    return NextResponse.json({ ok: true, sync, outgoing });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

