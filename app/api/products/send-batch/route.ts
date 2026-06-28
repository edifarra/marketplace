import { NextResponse } from "next/server";
import { sendPendingProductsToConfiguredTarget } from "@/lib/product-sender";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await sendPendingProductsToConfiguredTarget();
    return NextResponse.json({ ok: result.failed === 0, result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
