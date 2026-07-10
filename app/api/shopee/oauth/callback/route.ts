import { NextRequest, NextResponse } from "next/server";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";
import { createShopeeClient, getShopeeOAuthConfig } from "@/lib/shopee-oauth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
const OAUTH_ACCOUNT_COOKIE = "shopee_oauth_account";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") || "";
  const shopId = request.nextUrl.searchParams.get("shop_id") || request.nextUrl.searchParams.get("shopId") || "";
  const accountId = request.cookies.get(OAUTH_ACCOUNT_COOKIE)?.value
    || request.nextUrl.searchParams.get("accountId")
    || "";
  const error = request.nextUrl.searchParams.get("error") || "";

  if (error) {
    await logMarketplaceAccountEvent("error", "Erro OAuth Shopee", { accountId, error });
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(error)}`, request.url));
  }

  if (!code || !shopId) {
    await logMarketplaceAccountEvent("error", "Callback OAuth Shopee incompleto", {
      accountId,
      hasCode: Boolean(code),
      hasShopId: Boolean(shopId)
    });
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent("Retorno OAuth Shopee incompleto: code ou shop_id ausente.")}`, request.url));
  }

  const supabase = supabaseAdmin();
  await logMarketplaceAccountEvent("info", "Callback OAuth Shopee recebido", { accountId, shopId });

  try {
    const config = await getShopeeOAuthConfig(accountId || null);
    const client = createShopeeClient(config);
    const token = await client.exchangeCodeForToken(code, shopId);
    const accessToken = String(token.access_token || "");
    if (!accessToken) {
      throw new Error(`A Shopee nao retornou Access Token: ${String(token.message || token.error || "resposta invalida")}`);
    }

    await logMarketplaceAccountEvent("info", "Token OAuth Shopee recebido", {
      accountId,
      shopId,
      expiresIn: Number(token.expire_in || 0),
      hasRefreshToken: Boolean(token.refresh_token)
    });

    const shopInfo = await client.getShopInfo(accessToken, shopId);
    await logMarketplaceAccountEvent("info", "Dados da loja Shopee recebidos", { accountId, shopId });
    const existingAccountId = await findExistingShopeeAccount(shopId, accountId);
    const targetAccountId = existingAccountId || accountId || await createAccountFromCallback(shopId);
    const expiresIn = Number(token.expire_in || 0);
    const shopProfile = extractShopProfile(shopInfo);

    await supabase
      .from("config_marketplace_accounts")
      .update({
        marketplace: "shopee",
        account_id: shopId,
        shop_id: shopId,
        seller_id: String(token.merchant_id || shopProfile.merchantId || shopId),
        access_token: token.access_token || null,
        refresh_token: token.refresh_token || null,
        token_expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
        token_type: "Bearer",
        name: shopProfile.name || `Shopee ${shopId}`,
        nickname: shopProfile.name,
        email: shopProfile.email,
        raw_data: { token, shopInfo },
        status: "active",
        api_base_url: config.baseUrl,
        last_error: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", targetAccountId)
      .throwOnError();

    if (existingAccountId && accountId && existingAccountId !== accountId) {
      await supabase.from("config_marketplace_accounts").delete().eq("id", accountId);
      await logMarketplaceAccountEvent("warn", "Conta Shopee ja existente atualizada", {
        accountId,
        targetAccountId,
        shopId
      });
    } else {
      await logMarketplaceAccountEvent("info", "Token Shopee salvo", { accountId: targetAccountId, shopId });
    }

    const response = NextResponse.redirect(
      new URL(`/configuracoes/marketplace?sucesso=${encodeURIComponent("Conta Shopee conectada com sucesso.")}`, request.url)
    );
    response.cookies.delete(OAUTH_ACCOUNT_COOKIE);
    return response;
  } catch (errorInfo) {
    const message = errorInfo instanceof Error ? errorInfo.message : String(errorInfo);
    if (accountId) {
      await supabase.from("config_marketplace_accounts").update({ status: "error", last_error: message }).eq("id", accountId);
    }
    await logMarketplaceAccountEvent("error", "Erro de autenticacao Shopee", { accountId, shopId, error: message });
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(message)}`, request.url));
  }
}

async function findExistingShopeeAccount(shopId: string, currentAccountId: string) {
  const request = supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id")
    .eq("marketplace", "shopee")
    .eq("shop_id", shopId)
    .limit(1);

  const { data } = currentAccountId ? await request.neq("id", currentAccountId) : await request;
  return data?.[0]?.id ? String(data[0].id) : "";
}

async function createAccountFromCallback(shopId: string) {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .insert({
      name: `Shopee ${shopId}`,
      marketplace: "shopee",
      account_id: shopId,
      shop_id: shopId,
      active: true,
      status: "disconnected"
    })
    .select("id")
    .single()
    .throwOnError();

  return String(data.id);
}

function extractShopProfile(shopInfo: Record<string, unknown>) {
  const response = shopInfo.response as Record<string, unknown> | undefined;
  return {
    name: String(response?.shop_name || shopInfo.shop_name || ""),
    email: String(response?.email || shopInfo.email || ""),
    merchantId: String(response?.merchant_id || shopInfo.merchant_id || "")
  };
}
