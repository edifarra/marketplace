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
  status?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
};

const refreshesInProgress = new Map<string, Promise<string>>();
const TOKEN_SAFETY_WINDOW_MS = 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 60_000;
const REFRESH_WAIT_INTERVAL_MS = 500;

export function refreshMarketplaceAccountToken(accountId: string) {
  const currentRefresh = refreshesInProgress.get(accountId);
  if (currentRefresh) return currentRefresh;

  const refresh = refreshMarketplaceAccountTokenOnce(accountId)
    .finally(() => refreshesInProgress.delete(accountId));
  refreshesInProgress.set(accountId, refresh);
  return refresh;
}

async function refreshMarketplaceAccountTokenOnce(accountId: string) {
  for (let attempt = 0; attempt < REFRESH_LOCK_TIMEOUT_MS / REFRESH_WAIT_INTERVAL_MS; attempt++) {
    const account = await getMarketplaceTokenAccount(accountId);

    // A conta pode ter sido renovada por outra requisicao depois que o chamador
    // carregou sua copia. Revalidar aqui evita rotacionar um token ainda valido.
    if (hasValidAccessToken(account)) return String(account.access_token);

    const lockAge = account.updated_at ? Date.now() - new Date(account.updated_at).getTime() : Number.POSITIVE_INFINITY;
    if (account.status === "refreshing" && lockAge < REFRESH_LOCK_TIMEOUT_MS) {
      await wait(REFRESH_WAIT_INTERVAL_MS);
      continue;
    }

    const lockTime = new Date().toISOString();
    let lockQuery = supabaseAdmin()
      .from("config_marketplace_accounts")
      .update({ status: "refreshing", last_error: null, updated_at: lockTime })
      .eq("id", account.id);
    lockQuery = account.updated_at
      ? lockQuery.eq("updated_at", account.updated_at)
      : lockQuery.is("updated_at", null);
    const { data: locked, error: lockError } = await lockQuery
      .select("id")
      .maybeSingle();
    if (lockError) throw new Error(lockError.message);
    if (!locked) {
      await wait(REFRESH_WAIT_INTERVAL_MS);
      continue;
    }

    try {
      if (account.marketplace === "mercado_livre") {
        return await refreshMercadoLivreAccount(account.id);
      }
      if (account.marketplace === "shopee") {
        return await refreshShopeeAccount(account);
      }
      throw new Error(`Marketplace nao suportado para refresh: ${account.marketplace}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabaseAdmin()
        .from("config_marketplace_accounts")
        .update({ status: "error", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", account.id)
        .eq("status", "refreshing");
      await logMarketplaceAccountEvent("error", `Erro refresh token ${account.marketplace}`, {
        accountId: account.id,
        error: message
      });
      throw error;
    }
  }

  throw new Error("Tempo esgotado aguardando a renovacao de token em andamento.");
}

async function getMarketplaceTokenAccount(accountId: string) {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id,name,marketplace,shop_id,access_token,refresh_token,token_expires_at,status,last_error,updated_at")
    .eq("id", accountId)
    .single()
    .throwOnError();

  return data as MarketplaceTokenAccount;
}

function hasValidAccessToken(account: MarketplaceTokenAccount) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  return Boolean(account.access_token && expiresAt > Date.now() + TOKEN_SAFETY_WINDOW_MS);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
