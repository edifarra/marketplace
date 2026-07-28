import { NextResponse } from "next/server";
import {
  getMercadoLivreAccountById,
  getMercadoLivreAccountForNotification,
  getMercadoLivreShipment,
  getValidMercadoLivreAccessToken
} from "@/lib/mercado-livre";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getActiveShopeeAccounts, getValidShopeeAccessToken } from "@/lib/shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "@/lib/shopee-oauth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const { data: sale } = await supabaseAdmin()
      .from("venda")
      .select("id,marketplace,order_id,shipment_id,status_original,raw_data")
      .eq("id", params.id)
      .single()
      .throwOnError();

    if (sale.marketplace === "shopee") {
      return shopeeLabel(sale);
    }
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

async function shopeeLabel(sale: Record<string, any>) {
  const raw = (sale.raw_data || {}) as Record<string, any>;
  const shippingArranged = Boolean(raw.shopee_shipping_arranged_at)
    || String(sale.status_original || "").toUpperCase() === "PROCESSED";
  if (!shippingArranged) {
    return NextResponse.json({
      error: "Primeiro clique em Organizar envio para a Shopee aceitar o despacho."
    }, { status: 409 });
  }
  const accountId = String(raw.marketplace_account_id || "");
  const accounts = await getActiveShopeeAccounts();
  const account = accounts.find((item) => item.id === accountId)
    || (accounts.length === 1 ? accounts[0] : null);
  if (!account) throw new Error("Conta Shopee da venda não encontrada.");
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error("Shop ID da Shopee não configurado.");

  const accessToken = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const payload = (raw.payload || raw) as Record<string, any>;
  const orderPackages = Array.isArray(payload.order?.package_list) ? payload.order.package_list : [];
  const storedPackageNumber = orderPackages.find(
    (item: Record<string, any>) => item?.package_number
  )?.package_number;
  const packageNumber = raw.shopee_shipping_package_number
    ? String(raw.shopee_shipping_package_number)
    : storedPackageNumber ? String(storedPackageNumber) : null;
  const trackingResult = await client.getTrackingNumber(
    accessToken,
    shopId,
    String(sale.order_id),
    packageNumber
  );
  const trackingResponse = (trackingResult.response || {}) as Record<string, any>;
  const trackingNumber = String(trackingResponse.tracking_number || "");
  if (!trackingNumber) {
    return NextResponse.json({ error: "A Shopee ainda não informou o código de rastreio." }, { status: 409 });
  }
  try {
    await client.createShippingDocument(
      accessToken,
      shopId,
      String(sale.order_id),
      packageNumber,
      trackingNumber
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isShopeeLabelPendingError(message)) return labelPendingPage(String(sale.order_id), "aguardando liberação pela Shopee");
    if (!/already|exist|created|process/i.test(message)) throw error;
  }
  let result: Record<string, unknown> = {};
  try {
    result = await client.getShippingDocumentResult(
      accessToken, shopId, String(sale.order_id), packageNumber
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isShopeeLabelPendingError(message)) throw error;
  }
  const response = (result.response || {}) as Record<string, any>;
  const documentResult = Array.isArray(response.result_list) ? response.result_list[0] || {} : response;
  const status = String(documentResult.status || documentResult.shipping_document_status || "");
  try {
    const document = await client.downloadShippingDocument(
      accessToken, shopId, String(sale.order_id), packageNumber
    );
    return new NextResponse(document.body, {
      status: 200,
      headers: {
        "content-type": document.contentType,
        "content-disposition": `inline; filename="etiqueta-shopee-${sale.order_id}.pdf"`,
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isShopeeLabelPendingError(message)) {
      return labelPendingPage(String(sale.order_id), status || "em processamento pela Shopee");
    }
    throw error;
  }
}

function isShopeeLabelPendingError(message: string) {
  return /can_not_print|not yet ready|should_print|should print first|processing/i.test(message);
}

function labelPendingPage(orderId: string, status: string) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Etiqueta Shopee em processamento</title></head>
  <body style="font-family:Arial,sans-serif;padding:40px"><h1>Etiqueta em processamento</h1>
  <p>Pedido ${orderId}</p><p>A Shopee informou o estado ${status}. Aguarde alguns instantes e clique novamente em Imprimir etiqueta.</p>
  <a href="/vendas">Voltar para Vendas</a></body></html>`;
  return new NextResponse(html, { status: 409, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
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
