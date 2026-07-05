import { NextRequest, NextResponse } from "next/server";
import { getMercadoLivreOAuthConfig } from "@/lib/mercado-livre-oauth";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";
import { markMarketplaceReconnectStarted } from "@/lib/marketplace-accounts-view";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get("accountId");
    if (!accountId) {
      return NextResponse.redirect(new URL(
        `/configuracoes/marketplace?novo=mercado_livre&erro=${encodeURIComponent("Cadastre a conta Mercado Livre com Client ID, Client Secret e Redirect URI antes de conectar.")}`,
        request.url
      ));
    }

    const config = await getMercadoLivreOAuthConfig(accountId);
    await markMarketplaceReconnectStarted(accountId);
    await logMarketplaceAccountEvent("info", "Redirecionando OAuth Mercado Livre", { accountId });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      state: config.account.id,
      prompt: "login",
      max_age: "0"
    });

    return NextResponse.redirect(`https://auth.mercadolivre.com.br/authorization?${params.toString()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel iniciar a conexao com o Mercado Livre.";
    await logMarketplaceAccountEvent("error", "Erro ao iniciar OAuth Mercado Livre", { error: message });
    return NextResponse.redirect(new URL(`/integracoes?erro=${encodeURIComponent(message)}`, request.url));
  }
}
