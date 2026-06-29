import { NextRequest, NextResponse } from "next/server";
import { getMercadoLivreOAuthConfig } from "@/lib/mercado-livre-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  if (!accountId) {
    return NextResponse.json({ error: "Informe accountId." }, { status: 400 });
  }

  const config = await getMercadoLivreOAuthConfig(accountId);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: config.account.id
  });

  return NextResponse.redirect(`https://auth.mercadolivre.com.br/authorization?${params.toString()}`);
}
