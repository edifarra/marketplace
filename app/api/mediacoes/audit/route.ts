import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (request.headers.get("authorization") !== `Bearer ${secret}` && request.headers.get("x-cron-secret") !== secret)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }
  try {
    // O mesmo auditor pode ser executado manualmente ou pelo endpoint protegido.
    const { runMarketplaceModerationAudit } = require("../../../../scripts/audit-marketplace-moderations.cjs");
    return NextResponse.json({ ok: true, summary: await runMarketplaceModerationAudit() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
