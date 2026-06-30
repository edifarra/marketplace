import { getShopeeRedirectUri } from "./app-url";
import { logMarketplaceAccountEvent } from "./marketplace-account-logs";
import { ShopeeClient } from "./marketplaces/shopee/client";
import { supabaseAdmin } from "./supabase-admin";

const DEFAULT_SHOPEE_BASE_URL = "https://partner.shopeemobile.com";

type ShopeeOAuthAccount = {
  id: string;
  name?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  redirect_uri?: string | null;
  api_base_url?: string | null;
};

export async function getShopeeOAuthConfig(accountId?: string | null) {
  const supabase = supabaseAdmin();
  let account: ShopeeOAuthAccount | null = null;

  if (accountId) {
    const { data } = await supabase
      .from("config_marketplace_accounts")
      .select("id,name,client_id,client_secret,redirect_uri,api_base_url")
      .eq("id", accountId)
      .single()
      .throwOnError();
    account = data as ShopeeOAuthAccount;
  }

  const partnerId = account?.client_id || process.env.SHOPEE_PARTNER_ID || "";
  const partnerKey = account?.client_secret || process.env.SHOPEE_PARTNER_KEY || "";
  const baseUrl = account?.api_base_url || process.env.SHOPEE_API_BASE_URL || DEFAULT_SHOPEE_BASE_URL;

  if (!partnerId || !partnerKey) {
    throw new Error("Preencha SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY ou informe Client ID/Secret na conta Shopee.");
  }

  return {
    account,
    partnerId,
    partnerKey,
    redirectUri: getShopeeRedirectUri(account?.redirect_uri),
    baseUrl
  };
}

export async function createShopeeAccountPlaceholder() {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .insert({
      name: `Shopee ${new Date().toLocaleString("pt-BR")}`,
      marketplace: "shopee",
      active: true,
      status: "disconnected",
      api_base_url: process.env.SHOPEE_API_BASE_URL || DEFAULT_SHOPEE_BASE_URL
    })
    .select("id")
    .single()
    .throwOnError();

  await logMarketplaceAccountEvent("info", "Inicio OAuth Shopee", { accountId: data.id });
  return String(data.id);
}

export function createShopeeClient(config: Awaited<ReturnType<typeof getShopeeOAuthConfig>>) {
  return new ShopeeClient({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    redirectUri: config.redirectUri,
    baseUrl: config.baseUrl
  });
}
