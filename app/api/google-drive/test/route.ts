import { NextResponse } from "next/server";
import { testGoogleDriveConnection } from "@/lib/google-drive";

export async function GET() {
  try {
    const result = await testGoogleDriveConnection();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
