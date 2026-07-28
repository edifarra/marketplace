import { NextRequest, NextResponse } from "next/server";
import { GET as recoverMercadoLivre } from "@/app/api/mercado-livre/orders/recover/route";
import { GET as recoverShopee } from "@/app/api/shopee/orders/recover/route";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET nao configurado para executar a atualizacao." }, { status: 503 });
  }

  const headers = new Headers({ authorization: `Bearer ${secret}` });
  const origin = request.nextUrl.origin;
  const [mercadoLivre, shopee] = await Promise.all([
    recoverMercadoLivre(new NextRequest(`${origin}/api/mercado-livre/orders/recover?limit=50`, { headers })),
    recoverShopee(new NextRequest(`${origin}/api/shopee/orders/recover?hours=72`, { headers }))
  ]);
  const [mercadoLivreResult, shopeeResult] = await Promise.all([
    mercadoLivre.json(),
    shopee.json()
  ]);

  if (!mercadoLivre.ok || !shopee.ok) {
    return NextResponse.json({
      error: "A atualizacao terminou com falha em pelo menos um marketplace.",
      mercadoLivre: summarize(mercadoLivreResult),
      shopee: summarize(shopeeResult)
    }, { status: 502 });
  }

  const ml = summarize(mercadoLivreResult);
  const sp = summarize(shopeeResult);
  return NextResponse.json({
    ok: true,
    checked: ml.checked + sp.checked,
    updated: ml.updated + sp.updated,
    failed: ml.failed + sp.failed,
    mercadoLivre: ml,
    shopee: sp
  });
}

function summarize(payload: Record<string, any>) {
  const processed = (Array.isArray(payload.accounts) ? payload.accounts : [])
    .flatMap((account: Record<string, any>) => Array.isArray(account.processed) ? account.processed : []);
  return {
    checked: processed.length,
    updated: processed.filter((item: Record<string, any>) => item.ok && !item.result?.duplicated).length,
    failed: processed.filter((item: Record<string, any>) => !item.ok).length,
    error: String(payload.error || "")
  };
}
