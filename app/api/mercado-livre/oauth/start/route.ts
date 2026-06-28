import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getMercadoLivreRedirectUri } from "@/lib/app-url";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId") || "";
  if (!accountId) {
    return NextResponse.json({ error: "Informe accountId." }, { status: 400 });
  }

  const { data: account } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id,client_id,redirect_uri")
    .eq("id", accountId)
    .single()
    .throwOnError();

  if (!account.client_id) {
    return NextResponse.json({ error: "Preencha client_id em Configuracoes > MarketPlace." }, { status: 400 });
  }

  const redirectUri = getMercadoLivreRedirectUri(account.redirect_uri);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: account.client_id,
    redirect_uri: redirectUri,
    state: account.id
  });

  return NextResponse.redirect(`https://auth.mercadolivre.com.br/authorization?${params.toString()}`);
}
