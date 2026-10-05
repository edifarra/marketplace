import { NextResponse } from "next/server";
import { loadCaseDetail } from "@/lib/marketplace-case-detail";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) return NextResponse.json({ error: "Caso inválido." }, { status: 400 });
  try {
    const url = new URL(request.url);
    const at = url.searchParams.get("before");
    const beforeId = url.searchParams.get("beforeId");
    const sentValue = url.searchParams.get("beforeSent");
    if ((at || beforeId) && (!at || !beforeId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(beforeId))) return NextResponse.json({ error: "Cursor inválido." }, { status: 400 });
    if (sentValue && sentValue !== "null" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(sentValue) || !Number.isFinite(Date.parse(sentValue)))) return NextResponse.json({ error: "Cursor inválido." }, { status: 400 });
    const detail = await loadCaseDetail(params.id, undefined, at && beforeId ? { at, id: beforeId, sent: sentValue && sentValue !== "null" ? sentValue : null } : undefined);
    return NextResponse.json(detail || { error: "Caso não encontrado." }, { status: detail ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Não foi possível ler os detalhes locais do Caso." }, { status: 503 }); }
}
