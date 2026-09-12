import { NextRequest, NextResponse } from "next/server";
import { enqueueMarketplaceActivity } from "@/lib/marketplace-queue";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }
  try {
    const queued = await enqueueMarketplaceActivity({
      marketplace: "mercado_livre", payload: { topic: "conversation_sync", requested_at: new Date().toISOString() },
      eventType: "conversation_sync", description: "Reconciliação automática de chats solicitada."
    });
    return NextResponse.json({ ok: true, queued });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

