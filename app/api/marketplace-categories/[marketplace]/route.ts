import { NextRequest, NextResponse } from "next/server";
import { listMarketplaceCategories } from "@/lib/marketplace-categories";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: { marketplace: string } }) {
  try {
    const nodes = await listMarketplaceCategories(params.marketplace, request.nextUrl.searchParams.get("parent"));
    return NextResponse.json({ nodes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
