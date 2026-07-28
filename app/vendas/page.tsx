import { Sidebar } from "../components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { SalesGrid, type SaleGridRow } from "./sales-grid";
import { UpdateSalesButton } from "./update-sales-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Sale = {
  id: string; marketplace: string; order_id: string; status_original: string | null;
  valor_produtos: number; valor_frete: number; valor_taxas: number; valor_descontos: number; valor_liquido: number;
  data_venda: string | null; shipment_id: string | null; raw_data: Record<string, unknown> | null;
  created_at: string; updated_at: string; status_venda: { internal_status?: string; description?: string } | null;
};

export default async function SalesPage() {
  const db = supabaseAdmin();
  const [{ data: sales }, { data: items }, { data: accounts }, { data: products }] = await Promise.all([
    db.from("venda").select("id,marketplace,order_id,status_original,valor_produtos,valor_frete,valor_taxas,valor_descontos,valor_liquido,data_venda,shipment_id,raw_data,created_at,updated_at,status_venda(internal_status,description)").order("data_venda", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }),
    db.from("venda_item").select("venda_id,sku,quantidade,valor_unitario,valor_total"),
    db.from("config_marketplace_accounts").select("id,name,nickname,marketplace,seller_id,account_id,shop_id"),
    db.from("products").select("sku,title")
  ]);
  const productTitles = new Map((products || []).map((product) => [normalizeSku(product.sku), String(product.title || "")]));
  const itemMap = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items || []) itemMap.set(String(item.venda_id), [...(itemMap.get(String(item.venda_id)) || []), item]);
  const sortedSales = ((sales || []) as unknown as Sale[]).sort((left, right) => {
    const priority = Number(isReadyToShip(right)) - Number(isReadyToShip(left));
    if (priority !== 0) return priority;
    return saleTimestamp(right) - saleTimestamp(left);
  });
  const rows = sortedSales.map((sale): SaleGridRow => {
    const raw = sale.raw_data || {};
    const account = resolveAccount(sale, raw, accounts || []);
    const saleItems = itemMap.get(sale.id) || [];
    const sourceTitles = extractSourceTitles(raw);
    const shipping = extractShipping(raw);
    const shippingHistory = extractShippingHistory(raw);
    return {
      id: sale.id,
      date: dateTime(sale.data_venda || sale.created_at),
      marketplaceCode: sale.marketplace,
      marketplace: marketplaceLabel(sale.marketplace),
      nickname: String(raw.marketplace_nickname || account?.nickname || account?.name || "Loja não identificada"),
      totalItems: saleItems.reduce((total, item) => total + Number(item.quantidade || 0), 0),
      value: money(sale.valor_produtos),
      status: sale.status_venda?.description || statusLabel(sale.status_venda?.internal_status || sale.status_original),
      flex: isFlexShipping(shipping),
      shippingAction: shippingAction(sale, shipping),
      details: [
        { label: "Pedido", value: sale.order_id },
        { label: "Status recebido", value: sale.status_original || "Não informado" },
        { label: "Descrição do status", value: sale.status_venda?.description || statusLabel(sale.status_original) },
        { label: "Código da entrega", value: sale.shipment_id || "Não informado" },
        { label: "Valor dos produtos", value: money(sale.valor_produtos) },
        { label: "Tarifas", value: negativeMoney(sale.valor_taxas) },
        { label: "Custo de Frete", value: money(sale.valor_frete) },
        { label: "Descontos", value: money(sale.valor_descontos) },
        { label: "Valor líquido", value: money(sale.valor_liquido) },
        { label: "Última atualização", value: dateTime(sale.updated_at) }
      ],
      items: saleItems.map((item) => ({
        sku: String(item.sku || ""),
        description: productTitles.get(normalizeSku(item.sku)) || sourceTitles.get(normalizeSku(item.sku)) || "Descrição não encontrada",
        quantity: Number(item.quantidade || 0),
        unitValue: money(Number(item.valor_unitario || 0)),
        totalValue: money(Number(item.valor_total || 0))
      })),
      shippingHistory
    };
  });

  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Vendas</h1><div className="subtitle">Vendas efetivas recebidas dos marketplaces e seus status mais recentes.</div></div><UpdateSalesButton /></div>
    <section className="section card"><div className="table-toolbar"><div><h2>Vendas dos Marketplaces</h2><div className="muted">Clique em uma venda para visualizar os valores e itens.</div></div></div><SalesGrid rows={rows} /></section>
  </section></main>;
}

function extractSourceTitles(raw: Record<string, unknown>) {
  const payload = (raw.payload || raw) as Record<string, any>;
  const orderItems = payload?.order?.order_items || payload?.data?.items || payload?.data?.item_list || payload?.items || [];
  const titles = new Map<string, string>();
  for (const item of Array.isArray(orderItems) ? orderItems : []) {
    const sku = item?.item?.seller_sku || item?.item?.seller_custom_field || item?.model_sku || item?.item_sku || item?.sku;
    const title = item?.item?.title || item?.model_name || item?.item_name || item?.name || item?.title;
    if (sku && title) titles.set(normalizeSku(sku), String(title));
  }
  return titles;
}

function normalizeSku(value: unknown) {
  return String(value || "").trim().toLocaleUpperCase("pt-BR");
}

function resolveAccount(sale: Sale, raw: Record<string, unknown>, accounts: Array<Record<string, unknown>>) {
  const accountId = String(raw.marketplace_account_id || "");
  if (accountId) return accounts.find((account) => String(account.id) === accountId);
  const payload = (raw.payload || raw) as Record<string, any>;
  const externalId = String(payload?.notification?.user_id || payload?.shop_id || payload?.data?.shop_id || "");
  const candidates = accounts.filter((account) => account.marketplace === sale.marketplace);
  return candidates.find((account) => [account.seller_id, account.account_id, account.shop_id].some((id) => String(id || "") === externalId)) || (candidates.length === 1 ? candidates[0] : undefined);
}
function extractShipping(raw: Record<string, unknown>) {
  const payload = (raw.payload || raw) as Record<string, any>;
  return (payload.shipment || payload.order?.shipping || payload.data?.shipment || {}) as Record<string, any>;
}
function isFlexShipping(shipping: Record<string, any>) {
  return shipping.logistic_type === "self_service"
    || shipping.logistic?.type === "self_service"
    || shipping.shipping_mode === "flex"
    || shipping.tags?.includes?.("flex");
}
function shippingAction(sale: Sale, shipping: Record<string, any>): SaleGridRow["shippingAction"] {
  if (sale.marketplace === "mercado_livre") {
    if (shipping.status === "ready_to_ship" && String(shipping.substatus || "") === "invoice_pending") {
      return "emit_dce";
    }
    return shipping.status === "ready_to_ship"
      && ["ready_to_print", "printed"].includes(String(shipping.substatus || ""))
      ? "print_label"
      : null;
  }
  if (sale.marketplace !== "shopee") return null;
  const raw = (sale.raw_data || {}) as Record<string, any>;
  const shippingArranged = Boolean(raw.shopee_shipping_arranged_at);
  const status = String(sale.status_original || "");
  if (/^READY_TO_SHIP$/i.test(status) && !shippingArranged) return "arrange_shipment";
  if (shippingArranged || /^PROCESSED$/i.test(status)) return "print_label";
  return /^(CONFIRMED|TO_SHIP)$/i.test(status) ? "arrange_shipment" : null;
}
function isReadyToShip(sale: Sale) {
  if (sale.status_venda?.description) {
    return sale.status_venda.description.trim().toLocaleLowerCase("pt-BR") === "pronta para envio";
  }
  return /^(ready_to_ship|confirmed|handling)$/i.test(String(sale.status_original || ""));
}
function saleTimestamp(sale: Sale) {
  const value = new Date(sale.data_venda || sale.created_at).getTime();
  return Number.isFinite(value) ? value : 0;
}
function extractShippingHistory(raw: Record<string, unknown>) {
  const payload = (raw.payload || raw) as Record<string, any>;
  const history = Array.isArray(payload.shipmentHistory) ? payload.shipmentHistory : [];
  return [...history]
    .sort((a: Record<string, any>, b: Record<string, any>) => new Date(String(a.date || "")).getTime() - new Date(String(b.date || "")).getTime())
    .map((event: Record<string, any>) => ({
      date: dateTime(String(event.date || "")),
      status: shippingStatusLabel(String(event.status || ""), String(event.substatus || "")),
      description: shippingEventDescription(String(event.status || ""), String(event.substatus || ""))
    }));
}
function shippingStatusLabel(status: string, substatus: string) {
  if (status === "delivered") return "Entregue";
  if (substatus === "out_for_delivery" || substatus === "first_visit") return "Última etapa";
  if (status === "shipped" || ["picked_up", "in_hub", "dropped_off"].includes(substatus)) return "A caminho";
  if (status === "ready_to_ship") return "A enviar";
  if (status === "handling") return "Em preparação";
  return statusLabel(substatus || status);
}
function shippingEventDescription(status: string, substatus: string) {
  const descriptions: Record<string, string> = {
    handling: "Estamos preparando o pacote.",
    ready_to_print: "A etiqueta está pronta para impressão.",
    invoice_pending: "Aguardando documentação fiscal.",
    printed: "A etiqueta de envio foi impressa.",
    waiting_for_carrier_authorization: "Aguardando autorização da transportadora.",
    dropped_off: "Você enviou o pacote.",
    picked_up: "A transportadora coletou o pacote.",
    in_hub: "O pacote entrou no centro de distribuição.",
    in_packing_list: "O pacote está sendo preparado no centro de distribuição.",
    shipped: "O pacote está a caminho.",
    first_visit: "O pacote chegou à última etapa do percurso.",
    out_for_delivery: "O pacote saiu para entrega.",
    delivered: "Entregamos o pacote."
  };
  return descriptions[substatus] || descriptions[status] || String(substatus || status).replaceAll("_", " ");
}
function marketplaceLabel(value: string) { return value === "mercado_livre" ? "Mercado Livre" : value === "shopee" ? "Shopee" : value; }
function money(value: number) { return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function negativeMoney(value: number) { return value ? `-${money(Math.abs(Number(value)))}` : money(0); }
function dateTime(value: string) { return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "medium" }); }
function statusLabel(value: string | null | undefined) {
  const normalized = String(value || "unknown").toLowerCase();
  const labels: Record<string, string> = {
    confirmed: "A enviar", ready_to_ship: "A enviar", handling: "A enviar", shipped: "A caminho",
    shipped_to_return: "Enviado", in_transit: "A caminho", out_for_delivery: "Saiu para entrega",
    delivered: "Entregue", completed: "Concluída", paid: "Pago", payment_required: "Aguardando pagamento",
    payment_in_process: "Pagamento em processamento", unpaid: "Aguardando pagamento",
    cancelled: "Cancelada", refunded: "Reembolsada", to_return: "Devolução solicitada",
    criada: "Criada", nao_paga: "Aguardando pagamento", pagamento_em_processamento: "Pagamento em processamento",
    paga: "Paga", pronta_para_envio: "Pronta para envio", a_caminho: "A caminho",
    saiu_para_entrega: "Saiu para entrega", entregue: "Entregue", reembolsada: "Reembolsada",
    aguardando_pagamento: "Aguardando pagamento",
    enviada: "Enviada", concluida: "Concluída", cancelada: "Cancelada",
    devolucao_solicitada: "Devolução solicitada", cancelamento_solicitado: "Cancelamento solicitado"
  };
  return labels[normalized] || String(value || "Não informado").replaceAll("_", " ");
}
