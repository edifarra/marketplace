import { NextRequest, NextResponse } from "next/server";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";
import { createShopeeAccountPlaceholder, createShopeeClient, getShopeeOAuthConfig } from "@/lib/shopee-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || await createShopeeAccountPlaceholder();
  const config = await getShopeeOAuthConfig(accountId);
  const client = createShopeeClient(config);

  await logMarketplaceAccountEvent("info", "Redirecionando OAuth Shopee", { accountId });
  return NextResponse.redirect(client.buildAuthorizationUrl(accountId));
}
