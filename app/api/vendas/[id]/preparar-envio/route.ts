import { NextResponse } from "next/server";
import {
  emitMercadoLivreDce,
  getMercadoLivreAccountById,
  getMercadoLivreAccountForNotification
} from "@/lib/mercado-livre";
import { createShopeeClient, getShopeeOAuthConfig } from "@/lib/shopee-oauth";
import { getActiveShopeeAccounts, getValidShopeeAccessToken } from "@/lib/shopee";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const { data: sale } = await supabaseAdmin()
      .from("venda")
      .select("id,marketplace,order_id,shipment_id,status_original,raw_data")
      .eq("id", params.id)
      .single()
      .throwOnError();

    if (sale.marketplace === "mercado_livre") {
      await emitDce(sale);
    } else if (sale.marketplace === "shopee") {
      await arrangeShopeeShipment(sale);
    } else {
      return NextResponse.json({ error: "Ação não disponível para este marketplace." }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      labelUrl: `/api/vendas/${sale.id}/etiqueta`,
      waitMs: sale.marketplace === "mercado_livre" ? 6000 : 4000
    });
  } catch (error) {
    return NextResponse.json({
      error: friendlyError(error)
    }, { status: 409 });
  }
}

async function emitDce(sale: Record<string, any>) {
  const raw = (sale.raw_data || {}) as Record<string, any>;
  const payload = (raw.payload || raw) as Record<string, any>;
  const accountId = String(raw.marketplace_account_id || "");
  const sellerId = payload.notification?.user_id || payload.order?.seller?.id;
  const account = accountId
    ? await getMercadoLivreAccountById(accountId)
    : await getMercadoLivreAccountForNotification(sellerId);

  try {
    await emitMercadoLivreDce(String(sale.order_id), account);
  } catch (error) {
    if (!/already|emitted|issued|processing|in.progress|409/i.test(String(error))) throw error;
  }
}

async function arrangeShopeeShipment(sale: Record<string, any>) {
  const raw = (sale.raw_data || {}) as Record<string, any>;
  const accountId = String(raw.marketplace_account_id || "");
  const accounts = await getActiveShopeeAccounts();
  const account = accounts.find((item) => item.id === accountId)
    || (accounts.length === 1 ? accounts[0] : null);
  if (!account) throw new Error("Conta Shopee da venda não encontrada.");
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error("Shop ID da Shopee não configurado.");

  const accessToken = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const parameters = await client.getShippingParameter(accessToken, shopId, String(sale.order_id));
  const response = (parameters.response || {}) as Record<string, any>;
  const infoNeeded = (response.info_needed || {}) as Record<string, any>;
  const method = buildShippingMethod(infoNeeded, response);
  // Pedidos não divididos devem omitir package_number. A Shopee só o retorna
  // nos parâmetros logísticos quando o pedido foi efetivamente dividido.
  const packageNumber = response.package_number ? String(response.package_number) : null;
  const shipResult = await client.shipOrder(
    accessToken,
    shopId,
    String(sale.order_id),
    packageNumber,
    method
  );
  await supabaseAdmin()
    .from("venda")
    .update({
      shipment_id: packageNumber || sale.shipment_id || null,
      raw_data: {
        ...raw,
        shopee_shipping_arranged_at: new Date().toISOString(),
        shopee_shipping_package_number: packageNumber,
        shopee_shipping_arranged_response: shipResult
      },
      updated_at: new Date().toISOString()
    })
    .eq("id", sale.id)
    .throwOnError();
}

function buildShippingMethod(infoNeeded: Record<string, any>, response: Record<string, any>) {
  if (infoNeeded.pickup) {
    const address = response.pickup?.address_list?.[0];
    const slot = response.pickup?.time_slot_list?.[0];
    if (!address?.address_id || !slot?.pickup_time_id) {
      throw new Error("A Shopee exige a escolha de endereço e horário de coleta.");
    }
    return { pickup: { address_id: address.address_id, pickup_time_id: slot.pickup_time_id } };
  }
  if (infoNeeded.dropoff) {
    const branch = response.dropoff?.branch_list?.[0];
    return {
      dropoff: {
        ...(branch?.branch_id ? { branch_id: branch.branch_id } : {}),
        sender_real_name: String(response.dropoff?.sender_real_name || "Remetente")
      }
    };
  }
  if (infoNeeded.non_integrated) {
    throw new Error("Este envio exige que um código de rastreio seja informado manualmente.");
  }
  return {};
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/"message"\s*:\s*"([^"]+)"/i);
  return match?.[1] || message || "Não foi possível preparar o envio.";
}
