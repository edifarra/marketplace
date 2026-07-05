import { NextRequest, NextResponse } from "next/server";
import { createMercadoLivreAccountPlaceholder, getMercadoLivreOAuthConfig } from "@/lib/mercado-livre-oauth";
import { logMarketplaceAccountEvent } from "@/lib/marketplace-account-logs";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get("accountId") || await createMercadoLivreAccountPlaceholder();

    const config = await getMercadoLivreOAuthConfig(accountId);
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
