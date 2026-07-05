import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getMercadoLivreOAuthConfig } from "@/lib/mercado-livre-oauth";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
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
    const config = await getMercadoLivreOAuthConfig(accountId);
    await logMarketplaceAccountEvent("info", "Callback OAuth Mercado Livre recebido", { accountId });

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri
    });

    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      await updateMarketplaceAccount(accountId, { last_error: JSON.stringify(json) });
      await logMarketplaceAccountEvent("error", "Erro de autenticacao Mercado Livre", { accountId, error: json });
      return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(`Falha OAuth Mercado Livre: ${JSON.stringify(json)}`)}`, request.url));
    }

    const expiresIn = Number(json.expires_in || 0);
    const accessToken = String(json.access_token || "");
    const userInfo = accessToken ? await getMercadoLivreUserInfo(accessToken) : {};
    const sellerId = String(userInfo.id || json.user_id || "");
    const existingAccountId = sellerId ? await findExistingMercadoLivreAccount(sellerId, accountId) : "";
    const targetAccountId = existingAccountId || accountId;

    await updateMarketplaceAccount(targetAccountId, {
      access_token: json.access_token || null,
      refresh_token: json.refresh_token || null,
      token_expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scope: json.scope || null,
      token_type: json.token_type || null,
      seller_id: sellerId || null,
      account_id: sellerId || null,
      nickname: typeof userInfo.nickname === "string" ? userInfo.nickname : null,
      email: typeof userInfo.email === "string" ? userInfo.email : null,
      raw_data: userInfo,
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString()
    });

    if (existingAccountId) {
      await supabase.from("config_marketplace_accounts").delete().eq("id", accountId);
      await logMarketplaceAccountEvent("warn", "Conta Mercado Livre ja existente atualizada", {
        accountId,
        targetAccountId,
        sellerId
      });
    } else {
      await logMarketplaceAccountEvent("info", "Token Mercado Livre salvo", { accountId, sellerId });
    }

    return NextResponse.redirect(new URL("/configuracoes/marketplace", request.url));
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : String(callbackError);
    await logMarketplaceAccountEvent("error", "Erro no callback OAuth Mercado Livre", { error: message });
    return NextResponse.redirect(new URL(`/configuracoes/marketplace?erro=${encodeURIComponent(message)}`, request.url));
  }
}

async function getMercadoLivreUserInfo(accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  return response.json().catch(() => ({}));
}

async function findExistingMercadoLivreAccount(sellerId: string, currentAccountId: string) {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id")
    .eq("marketplace", "mercado_livre")
    .eq("seller_id", sellerId)
    .neq("id", currentAccountId)
    .limit(1);

  return data?.[0]?.id ? String(data[0].id) : "";
}

async function updateMarketplaceAccount(accountId: string, payload: Record<string, unknown>) {
  const supabase = supabaseAdmin();
  let currentPayload = { ...payload };

  for (let attempt = 0; attempt < Object.keys(payload).length; attempt += 1) {
    const result = await supabase
      .from("config_marketplace_accounts")
      .update(currentPayload)
      .eq("id", accountId);

    if (!result.error) {
      return;
    }

    const missingColumn = extractMissingColumn(result.error.message);
    if (!missingColumn || !(missingColumn in currentPayload)) {
      throw new Error(result.error.message);
    }

    delete currentPayload[missingColumn];
  }
}

function extractMissingColumn(message: string) {
  const patterns = [
    /column\s+[^.]+\.(\w+)\s+does not exist/i,
    /Could not find the ['"]?(\w+)['"]? column/i,
    /Could not find ['"]?(\w+)['"]? in the schema cache/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}
