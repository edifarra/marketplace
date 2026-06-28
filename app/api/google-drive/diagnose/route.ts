import { NextResponse } from "next/server";
import { diagnoseGoogleDrive } from "@/lib/google-drive";
import { saveGoogleDriveDiagnosticResult } from "@/lib/google-drive-config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await diagnoseGoogleDrive();
    await saveGoogleDriveDiagnosticResult(result.ok ? "Sucesso" : "Falha", result);
    return NextResponse.json(result);
  } catch (error) {
    const result = {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
    await saveGoogleDriveDiagnosticResult("Falha", result);
    return NextResponse.json(result, { status: 500 });
  }
}
