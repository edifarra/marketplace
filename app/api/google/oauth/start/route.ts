import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildGoogleOAuthUrl } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const state = randomBytes(16).toString("hex");
    const response = NextResponse.redirect(buildGoogleOAuthUrl(state));
    response.cookies.set("google_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const url = new URL("/configuracoes/google-drive", request.nextUrl.origin);
    url.searchParams.set("erro", message);
    return NextResponse.redirect(url);
  }
}
