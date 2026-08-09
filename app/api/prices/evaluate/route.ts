import { NextRequest, NextResponse } from "next/server";
import { evaluatePrice } from "@/lib/price-evaluation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!process.env.CRON_SECRET || (secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }
  try {
    const query = request.nextUrl.searchParams.get("q") || "";
    const evaluation = await evaluatePrice(query, { forceOnline: request.nextUrl.searchParams.get("online") === "1" });
    return NextResponse.json({ ok: true, evaluation });
  } catch (cause) {
    return NextResponse.json({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 });
  }
}
