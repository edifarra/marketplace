import { NextResponse } from "next/server";
import { getBatchSendProgress } from "@/lib/product-sender";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ progress: await getBatchSendProgress() });
}
