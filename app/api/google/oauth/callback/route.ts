import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleOAuthCode } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") || "";
  const state = request.nextUrl.searchParams.get("state") || "";
  const error = request.nextUrl.searchParams.get("error") || "";
  const cookieState = request.cookies.get("google_oauth_state")?.value || "";
  const configUrl = new URL("/configuracoes/google-drive", request.nextUrl.origin);

  try {
    if (error) {
      throw new Error(`OAuth Google recusado: ${error}`);
    }

    if (!code) {
      throw new Error("OAuth Google nao retornou code.");
    }

    if (cookieState && state !== cookieState) {
      throw new Error("OAuth Google retornou state invalido.");
    }

    await exchangeGoogleOAuthCode(code);
    configUrl.searchParams.set("google", "conectado");
  } catch (oauthError) {
    configUrl.searchParams.set(
      "erro",
      oauthError instanceof Error ? oauthError.message : String(oauthError)
    );
  }

  const response = NextResponse.redirect(configUrl);
  response.cookies.delete("google_oauth_state");
  return response;
}
