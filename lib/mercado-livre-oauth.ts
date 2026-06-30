import { getMercadoLivreRedirectUri } from "./app-url";
import { logMarketplaceAccountEvent } from "./marketplace-account-logs";
import { supabaseAdmin } from "./supabase-admin";

type MercadoLivreOAuthAccount = {
  id: string;
  name?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  redirect_uri?: string | null;
};

export async function getMercadoLivreOAuthConfig(accountId: string) {
  const supabase = supabaseAdmin();
  const { data: account } = await supabase
    .from("config_marketplace_accounts")
    .select("id,name,client_id,client_secret,redirect_uri")
    .eq("id", accountId)
    .single()
    .throwOnError();

  const current = account as MercadoLivreOAuthAccount;
  if (current.client_id && current.client_secret) {
    return {
      account: current,
      clientId: current.client_id,
      clientSecret: current.client_secret,
      redirectUri: getMercadoLivreRedirectUri(current.redirect_uri)
    };
  }

  const { data: fallbackRows } = await supabase
    .from("config_marketplace_accounts")
    .select("id,name,client_id,client_secret,redirect_uri")
    .eq("marketplace", "mercado_livre")
    .not("client_id", "is", null)
    .not("client_secret", "is", null)
    .limit(1);

  const fallback = (fallbackRows || []).find((row) => row.client_id && row.client_secret) as MercadoLivreOAuthAccount | undefined;
  if (!fallback?.client_id || !fallback.client_secret) {
    throw new Error("Preencha Client ID e Client Secret em pelo menos uma configuracao Mercado Livre.");
  }

  return {
    account: current,
    clientId: fallback.client_id,
    clientSecret: fallback.client_secret,
    redirectUri: getMercadoLivreRedirectUri(current.redirect_uri || fallback.redirect_uri)
  };
}

export async function createMercadoLivreAccountPlaceholder() {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .insert({
      name: `Mercado Livre ${new Date().toLocaleString("pt-BR")}`,
      marketplace: "mercado_livre",
      active: true,
      status: "disconnected"
    })
    .select("id")
    .single()
    .throwOnError();

  await logMarketplaceAccountEvent("info", "Inicio OAuth Mercado Livre", { accountId: data.id });
  return String(data.id);
}
