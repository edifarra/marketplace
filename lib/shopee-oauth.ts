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
  let account: ShopeeOAuthAccount | null = null;

  if (accountId) {
    account = await getShopeeAccount(accountId);
  }

  const partnerId = account?.client_id || process.env.SHOPEE_PARTNER_ID || "";
  const partnerKey = account?.client_secret || process.env.SHOPEE_PARTNER_KEY || "";
  const baseUrl = account?.api_base_url || process.env.SHOPEE_API_BASE_URL || DEFAULT_SHOPEE_BASE_URL;

  if (!partnerId || !partnerKey) {
    throw new Error(
      "Credenciais da Shopee ausentes. Preencha Partner ID e Partner Key na conta Shopee ou configure SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY na Vercel."
    );
  }

  if (!/^\d+$/.test(partnerId)) {
    throw new Error("Partner ID da Shopee invalido: informe apenas os numeros fornecidos pela Shopee Open Platform.");
  }

  validateHttpsUrl(baseUrl, "API Base URL da Shopee");

  const redirectUri = getShopeeRedirectUri(account?.redirect_uri);
  validateHttpsUrl(redirectUri, "Redirect URI da Shopee");

  return {
    account,
    partnerId,
    partnerKey,
    redirectUri,
    baseUrl
  };
}

export async function createShopeeAccountPlaceholder() {
  const db = supabaseAdmin();
  const payload = {
    name: `Shopee ${new Date().toLocaleString("pt-BR")}`,
    marketplace: "shopee",
    active: true,
    status: "disconnected",
    api_base_url: process.env.SHOPEE_API_BASE_URL || DEFAULT_SHOPEE_BASE_URL
  };
  let result = await db
    .from("config_marketplace_accounts")
    .insert(payload)
    .select("id")
    .single();

  if (result.error && isMissingApiBaseUrlColumn(result.error.message)) {
    const { api_base_url: _ignored, ...legacyPayload } = payload;
    result = await db.from("config_marketplace_accounts").insert(legacyPayload).select("id").single();
  }
  if (result.error || !result.data) throw new Error(result.error?.message || "Nao foi possivel criar a conta Shopee.");

  await logMarketplaceAccountEvent("info", "Inicio OAuth Shopee", { accountId: result.data.id });
  return String(result.data.id);
}

export function createShopeeClient(config: Awaited<ReturnType<typeof getShopeeOAuthConfig>>) {
  return new ShopeeClient({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    redirectUri: config.redirectUri,
    baseUrl: config.baseUrl
  });
}

async function getShopeeAccount(accountId: string): Promise<ShopeeOAuthAccount> {
  const supabase = supabaseAdmin();
  const fullResult = await supabase
    .from("config_marketplace_accounts")
    .select("id,name,client_id,client_secret,redirect_uri,api_base_url")
    .eq("id", accountId)
    .maybeSingle();

  if (!fullResult.error && fullResult.data) {
    return fullResult.data as ShopeeOAuthAccount;
  }

  // api_base_url foi adicionada depois das demais credenciais. O OAuth continua
  // funcionando com a URL oficial enquanto a migracao e aplicada em producao.
  if (fullResult.error && isMissingApiBaseUrlColumn(fullResult.error.message)) {
    const legacyResult = await supabase
      .from("config_marketplace_accounts")
      .select("id,name,client_id,client_secret,redirect_uri")
      .eq("id", accountId)
      .maybeSingle();

    if (!legacyResult.error && legacyResult.data) {
      return legacyResult.data as ShopeeOAuthAccount;
    }

    if (legacyResult.error) {
      throw new Error(`Nao foi possivel carregar a conta Shopee: ${legacyResult.error.message}`);
    }
  }

  if (fullResult.error) {
    throw new Error(`Nao foi possivel carregar a conta Shopee: ${fullResult.error.message}`);
  }

  throw new Error("Conta Shopee nao encontrada. Cadastre novamente a conta em Configuracoes > Marketplace.");
}

function isMissingApiBaseUrlColumn(message: string) {
  return /api_base_url|schema cache|Could not find/i.test(message);
}

function validateHttpsUrl(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} invalida.`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${label} precisa usar HTTPS.`);
  }
}
