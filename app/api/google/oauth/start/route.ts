import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildGoogleDriveConnectUrl } from "@/lib/google-drive-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email")?.trim() || "";
  const configUrl = new URL("/configuracoes/google-drive", request.nextUrl.origin);

  try {
    if (!email) {
      throw new Error("Informe o e-mail da conta Google Drive.");
    }

    const state = randomBytes(16).toString("hex");
    const response = NextResponse.redirect(buildGoogleDriveConnectUrl(state, email));
    response.cookies.set("google_drive_state", state, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60
    });
    response.cookies.set("google_drive_email", email, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60
    });
    return response;
  } catch (error) {
    configUrl.searchParams.set("erro", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(configUrl);
  }
}
