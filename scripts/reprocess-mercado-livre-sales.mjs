import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const { data: sales, error: salesError } = await supabase
  .from("venda")
  .select("order_id")
  .eq("marketplace", "mercado_livre")
  .order("created_at");
if (salesError) throw salesError;

const { data: accounts, error: accountsError } = await supabase
  .from("config_marketplace_accounts")
  .select("id,name,nickname,seller_id,account_id,access_token")
  .eq("marketplace", "mercado_livre")
  .eq("active", true);
if (accountsError) throw accountsError;

const summary = { evaluated: sales.length, updated: 0, failed: 0, failures: [] };

for (const sale of sales) {
  try {
    const { order, account } = await getOrder(String(sale.order_id), accounts);
    const shipmentId = String(order.shipping?.id || "");
    const [shipment, shipmentHistory] = shipmentId
      ? await Promise.all([
          mlGet(`/shipments/${shipmentId}`, account.access_token, true),
          mlGet(`/shipments/${shipmentId}/history`, account.access_token, true)
        ])
      : [{}, []];
    const fees = (order.order_items || []).reduce((total, item) => total + number(item.sale_fee), 0);
    const freight = (order.payments || []).reduce((total, payment) => total + number(payment.shipping_cost), 0);
    const value = number(order.total_amount);
    const status = shipment.substatus === "out_for_delivery"
      ? "out_for_delivery"
      : String(shipment.status || order.status || "unknown");

    const { data: savedSale, error: saveError } = await supabase.from("venda").upsert({
      marketplace: "mercado_livre",
      order_id: String(order.id),
      status_id: null,
      status_original: status,
      valor_produtos: value,
      valor_frete: freight,
      valor_taxas: fees,
      valor_liquido: value + freight - fees,
      data_venda: order.date_created,
      shipment_id: shipmentId || null,
      raw_data: {
        payload: { notification: { recovery: true }, order, shipment, shipmentHistory },
        marketplace_account_id: account.id,
        marketplace_nickname: account.nickname || account.name
      },
      updated_at: new Date().toISOString()
    }, { onConflict: "marketplace,order_id" }).select("id").single();
    if (saveError) throw saveError;

    for (const item of order.order_items || []) {
      const sku = String(item.item?.seller_sku || item.item?.seller_custom_field || "").trim();
      if (!sku) continue;
      const quantity = number(item.quantity) || 1;
      const unitPrice = number(item.unit_price);
      const { error } = await supabase.from("venda_item").upsert({
        venda_id: savedSale.id,
        order_id: String(order.id),
        sku,
        quantidade: quantity,
        valor_unitario: unitPrice,
        valor_total: unitPrice * quantity,
        raw_data: { order_item: item }
      }, { onConflict: "venda_id,sku" });
      if (error) throw error;
    }
    summary.updated++;
  } catch (error) {
    summary.failed++;
    summary.failures.push({ orderId: String(sale.order_id), message: error instanceof Error ? error.message : String(error) });
  }
}

console.log(JSON.stringify(summary, null, 2));

async function getOrder(orderId, accountRows) {
  let lastError = new Error(`Pedido ${orderId} não encontrado.`);
  for (const account of accountRows) {
    try {
      return { order: await mlGet(`/orders/${orderId}`, account.access_token), account };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function mlGet(path, accessToken, newFormat = false) {
  const response = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(newFormat ? { "x-format-new": "true" } : {})
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
