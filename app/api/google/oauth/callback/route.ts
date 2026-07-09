import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleDriveCode } from "@/lib/google-drive-oauth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") || "";
  const state = request.nextUrl.searchParams.get("state") || "";
  const error = request.nextUrl.searchParams.get("error") || "";
  const cookieState = request.cookies.get("google_drive_state")?.value || "";
  const requestedEmail = request.cookies.get("google_drive_email")?.value || "";
  const configUrl = new URL("/configuracoes/google-drive", request.nextUrl.origin);

  try {
    if (error) {
      throw new Error(`Google recusou a conexao: ${error}`);
    }

    if (!code) {
      throw new Error("Google nao retornou o codigo de conexao.");
    }

    if (cookieState && state !== cookieState) {
      throw new Error("Retorno do Google invalido. Tente conectar novamente.");
    }

    await exchangeGoogleDriveCode(code, requestedEmail);
    await clearLegacyDriveConnectionError();
  } catch (connectError) {
    configUrl.searchParams.set("erro", connectError instanceof Error ? connectError.message : String(connectError));
  }

  const response = NextResponse.redirect(configUrl);
  response.cookies.delete("google_drive_state");
  response.cookies.delete("google_drive_email");
  return response;
}

async function clearLegacyDriveConnectionError() {
  const supabase = supabaseAdmin();
  const finishedAt = new Date().toISOString();
  await supabase.from("pipeline_runs").insert({
    status: "done",
    stage: "drive_collect",
    started_at: finishedAt,
    finished_at: finishedAt,
    metrics: {
      drive: {
        totalFound: 0,
        totalValid: 0,
        totalMoved: 0,
        totalCopied: 0,
        totalFailed: 0
      },
      message: "Conta Google Drive conectada."
    }
  });
}
