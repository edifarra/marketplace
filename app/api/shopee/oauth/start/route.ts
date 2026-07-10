import { NextRequest, NextResponse } from "next/server";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";
import { createShopeeAccountPlaceholder, createShopeeClient, getShopeeOAuthConfig } from "@/lib/shopee-oauth";

export const dynamic = "force-dynamic";
const OAUTH_ACCOUNT_COOKIE = "shopee_oauth_account";

export async function GET(request: NextRequest) {
  let accountId = request.nextUrl.searchParams.get("accountId")?.trim() || "";

  try {
    accountId = accountId || await createShopeeAccountPlaceholder();
    const config = await getShopeeOAuthConfig(accountId);
    const client = createShopeeClient(config);
    const authorizationUrl = client.buildAuthorizationUrl();

    await logMarketplaceAccountEvent("info", "Redirecionando OAuth Shopee", {
      accountId,
      partnerId: config.partnerId,
      redirectUri: config.redirectUri,
      apiBaseUrl: config.baseUrl
    });
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(OAUTH_ACCOUNT_COOKIE, accountId, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 10 * 60,
      path: "/api/shopee/oauth/callback"
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logMarketplaceAccountEvent("error", "Falha ao iniciar OAuth Shopee", {
      accountId: accountId || null,
      error: message
    });

    return NextResponse.redirect(
      new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(message)}`, request.url)
    );
  }
}
