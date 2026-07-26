import { NextResponse } from "next/server";
import {
  getMercadoLivreAccountById,
  getMercadoLivreAccountForNotification,
  getMercadoLivreShipment,
  getValidMercadoLivreAccessToken
} from "@/lib/mercado-livre";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const { data: sale } = await supabaseAdmin()
      .from("venda")
      .select("id,marketplace,order_id,shipment_id,status_original,raw_data")
      .eq("id", params.id)
      .single()
      .throwOnError();

    if (sale.marketplace !== "mercado_livre") {
      return NextResponse.json({ error: "Etiqueta ainda não disponível para este marketplace." }, { status: 400 });
    }
    if (!sale.shipment_id) {
      return NextResponse.json({ error: "Venda sem código de envio." }, { status: 400 });
    }

    const raw = (sale.raw_data || {}) as Record<string, any>;
    const payload = (raw.payload || raw) as Record<string, any>;
    const accountId = String(raw.marketplace_account_id || "");
    const sellerId = payload.notification?.user_id || payload.order?.seller?.id;
    const account = accountId
      ? await getMercadoLivreAccountById(accountId)
      : await getMercadoLivreAccountForNotification(sellerId);
    const shipment = await getMercadoLivreShipment(String(sale.shipment_id), account);
    const printable = shipment.status === "ready_to_ship"
      && ["ready_to_print", "printed"].includes(String(shipment.substatus || ""));
    if (!printable) {
      return labelUnavailablePage(
        String(sale.order_id),
        String(shipment.status || sale.status_original || ""),
        String(shipment.substatus || "")
      );
    }

    const accessToken = await getValidMercadoLivreAccessToken(account);
    const response = await fetch(
      `https://api.mercadolibre.com/shipment_labels?shipment_ids=${encodeURIComponent(String(sale.shipment_id))}&response_type=pdf`,
      { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" }
    );
    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json({ error: `Falha ao gerar etiqueta: ${error}` }, { status: response.status });
    }

    return new NextResponse(await response.arrayBuffer(), {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") || "application/pdf",
        "content-disposition": `inline; filename="etiqueta-${sale.order_id}.pdf"`,
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Não foi possível obter a etiqueta."
    }, { status: 500 });
  }
}

function labelUnavailablePage(orderId: string, status: string, substatus: string) {
  const invoicePending = substatus === "invoice_pending";
  const title = invoicePending ? "Etiqueta aguardando documento fiscal" : "Etiqueta ainda não liberada";
  const message = invoicePending
    ? "O Mercado Livre informa que este envio está A enviar, mas a etiqueta permanece bloqueada até a emissão ou importação do documento fiscal."
    : `O Mercado Livre ainda não permite imprimir esta etiqueta. Estado atual: ${status || "não informado"}${substatus ? ` / ${substatus}` : ""}.`;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:Arial,sans-serif;background:#f6f7f9;color:#17202a;margin:0;padding:40px}.card{max-width:650px;margin:auto;background:#fff;border:1px solid #d9dde5;border-radius:10px;padding:28px}.warning{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#fff3cd;color:#8a5700;font-weight:800}h1{font-size:22px}p{line-height:1.5;color:#475467}a{display:inline-block;margin-top:12px;padding:9px 13px;border-radius:6px;background:#165dff;color:#fff;text-decoration:none}</style>
  </head><body><div class="card"><span class="warning">!</span><h1>${title}</h1><p>Pedido ${orderId}</p><p>${message}</p><p>Assim que o marketplace liberar o PDF, este mesmo botão abrirá a etiqueta pronta para impressão.</p><a href="/vendas">Voltar para Vendas</a></div></body></html>`;
  return new NextResponse(html, {
    status: 409,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" }
  });
}
