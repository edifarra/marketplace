import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getMercadoLivreRedirectUri } from "@/lib/app-url";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") || "";
  const accountId = request.nextUrl.searchParams.get("state") || "";
  const error = request.nextUrl.searchParams.get("error") || "";

  if (error) {
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(error)}`, request.url));
  }

  if (!code || !accountId) {
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent("Retorno OAuth Mercado Livre incompleto.")}`, request.url));
  }

  const supabase = supabaseAdmin();
  const { data: account } = await supabase
    .from("config_marketplace_accounts")
    .select("id,client_id,client_secret,redirect_uri")
    .eq("id", accountId)
    .single()
    .throwOnError();

  if (!account.client_id || !account.client_secret) {
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent("Client ID e Client Secret sao obrigatorios.")}`, request.url));
  }

  const redirectUri = getMercadoLivreRedirectUri(account.redirect_uri);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: account.client_id,
    client_secret: account.client_secret,
    code,
    redirect_uri: redirectUri
  });

  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    await supabase.from("config_marketplace_accounts").update({ last_error: JSON.stringify(json) }).eq("id", accountId);
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(`Falha OAuth Mercado Livre: ${JSON.stringify(json)}`)}`, request.url));
  }

  const expiresIn = Number(json.expires_in || 0);
  await supabase
    .from("config_marketplace_accounts")
    .update({
      access_token: json.access_token || null,
      refresh_token: json.refresh_token || null,
      token_expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: json.scope || null,
      token_type: json.token_type || null,
      seller_id: json.user_id ? String(json.user_id) : null,
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", accountId)
    .throwOnError();

  return NextResponse.redirect(new URL("/configuracoes/marketplace", request.url));
}
