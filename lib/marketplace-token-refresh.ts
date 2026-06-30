import { getMercadoLivreOAuthConfig } from "./mercado-livre-oauth";
import { logMarketplaceAccountEvent } from "./marketplace-account-logs";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { supabaseAdmin } from "./supabase-admin";

type MarketplaceTokenAccount = {
  id: string;
  name: string;
  marketplace: string;
  shop_id?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
};

export async function refreshMarketplaceAccountToken(accountId: string) {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id,name,marketplace,shop_id,access_token,refresh_token,token_expires_at")
    .eq("id", accountId)
    .single()
    .throwOnError();

  const account = data as MarketplaceTokenAccount;
  if (account.marketplace === "mercado_livre") {
    return refreshMercadoLivreAccount(account.id);
  }
  if (account.marketplace === "shopee") {
    return refreshShopeeAccount(account);
  }

  throw new Error(`Marketplace nao suportado para refresh: ${account.marketplace}`);
}

async function refreshMercadoLivreAccount(accountId: string) {
  const config = await getMercadoLivreOAuthConfig(accountId);
  const { data: account } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("refresh_token")
    .eq("id", accountId)
    .single()
    .throwOnError();

  if (!account?.refresh_token) {
    throw new Error("Conta Mercado Livre sem refresh_token.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: String(account.refresh_token)
  });
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    await logMarketplaceAccountEvent("error", "Erro refresh token Mercado Livre", { accountId, error: json });
    throw new Error(`Falha ao renovar Mercado Livre: ${JSON.stringify(json)}`);
  }

  const expiresIn = Number(json.expires_in || 0);
  await supabaseAdmin()
    .from("config_marketplace_accounts")
    .update({
      access_token: json.access_token || null,
      refresh_token: json.refresh_token || account.refresh_token,
      token_expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: json.scope || null,
      token_type: json.token_type || null,
      seller_id: json.user_id ? String(json.user_id) : null,
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", accountId)
    .throwOnError();

  await logMarketplaceAccountEvent("info", "Refresh token Mercado Livre executado", { accountId });
  return String(json.access_token || "");
}

async function refreshShopeeAccount(account: MarketplaceTokenAccount) {
  if (!account.refresh_token || !account.shop_id) {
    throw new Error(`Conta Shopee ${account.name} sem refresh_token ou shop_id.`);
  }

  const config = await getShopeeOAuthConfig(account.id);
  const client = createShopeeClient(config);
  const json = await client.refreshAccessToken(account.refresh_token, account.shop_id);
  const expiresIn = Number(json.expire_in || 0);

  await supabaseAdmin()
    .from("config_marketplace_accounts")
    .update({
      access_token: json.access_token || account.access_token || null,
      refresh_token: json.refresh_token || account.refresh_token,
      token_expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", account.id)
    .throwOnError();

  await logMarketplaceAccountEvent("info", "Refresh token Shopee executado", { accountId: account.id, shopId: account.shop_id });
  return String(json.access_token || account.access_token || "");
}
