import { Sidebar } from "../components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { SalesGrid, type SaleGridRow } from "./sales-grid";
import { UpdateSalesButton } from "./update-sales-button";
import { deferredShipping, extractSaleShipping, saleShippingAction } from "@/lib/sales-fulfillment";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Sale = {
  id: string; marketplace: string; order_id: string; status_original: string | null;
  valor_produtos: number; valor_frete: number; valor_taxas: number; valor_descontos: number; valor_liquido: number;
  data_venda: string | null; shipment_id: string | null; raw_data: Record<string, unknown> | null;
  created_at: string; updated_at: string; status_venda: { internal_status?: string; description?: string } | null;
};

export default async function SalesPage({ searchParams }: { searchParams?: { orderId?: string; sku?: string } }) {
  const orderIdFilter = String(searchParams?.orderId || "").trim().toLocaleUpperCase("pt-BR");
  const skuFilter = normalizeSku(searchParams?.sku);
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
  const sortedSales = ((sales || []) as unknown as Sale[])
    .filter((sale) => !orderIdFilter || sale.order_id.toLocaleUpperCase("pt-BR").includes(orderIdFilter))
    .filter((sale) => !skuFilter || (itemMap.get(sale.id) || []).some((item) => normalizeSku(item.sku).includes(skuFilter)))
    .sort(compareSales);
  const rows = sortedSales.map((sale): SaleGridRow => {
    const raw = sale.raw_data || {};
    const account = resolveAccount(sale, raw, accounts || []);
    const saleItems = itemMap.get(sale.id) || [];
    const sourceTitles = extractSourceTitles(raw);
    const shipping = extractSaleShipping(raw);
    const shippingHistory = extractShippingHistory(raw);
    const deferred = deferredShipping(sale);
    return {
      id: sale.id,
      date: dateTime(sale.data_venda || sale.created_at),
      marketplaceCode: sale.marketplace,
      marketplace: marketplaceLabel(sale.marketplace),
      nickname: String(raw.marketplace_nickname || account?.nickname || account?.name || "Loja não identificada"),
      totalItems: saleItems.reduce((total, item) => total + Number(item.quantidade || 0), 0),
      value: money(sale.valor_produtos),
      status: sale.status_venda?.description || statusLabel(sale.status_venda?.internal_status || sale.status_original),
      unpaid: isUnpaidSale(sale),
      flex: isFlexShipping(shipping),
      shippingAction: deferred ? null : saleShippingAction(sale),
      shippingActionText: deferred?.label || null,
      sortGroup: saleShippingAction(sale) ? 0 : deferred ? 1 : 2,
      shopRank: saleShopRank(sale.marketplace, String(raw.marketplace_nickname || account?.nickname || account?.name || "")),
      saleTimestamp: saleTimestamp(sale),
      deferredTimestamp: deferred?.timestamp || 0,
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
  }).sort(compareSaleRows);

  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Vendas</h1><div className="subtitle">Vendas efetivas recebidas dos marketplaces e seus status mais recentes.</div></div><UpdateSalesButton /></div>
    <section className="card form-card">
      <form action="/vendas" method="get">
        <div className="table-toolbar">
          <div><h2>Filtros</h2><div className="muted">Localize uma venda pelo pedido, pelo SKU ou pelos dois campos.</div></div>
          <div className="row-actions"><button className="secondary" type="submit">Aplicar</button><a className="secondary link-button" href="/vendas">Limpar filtros</a></div>
        </div>
        <div className="form-grid">
          <label>ID do Pedido<input name="orderId" placeholder="Ex.: 260803B7UJXWWW" defaultValue={searchParams?.orderId || ""} /></label>
          <label>SKU do Produto<input name="sku" placeholder="Ex.: 345TC" defaultValue={searchParams?.sku || ""} /></label>
        </div>
      </form>
    </section>
    <section className="section card"><div className="table-toolbar"><div><h2>Vendas dos Marketplaces</h2><div className="muted">{rows.length} venda(s) encontrada(s). Clique em uma venda para visualizar os valores e itens.</div></div></div><SalesGrid rows={rows} /></section>
  </section></main>;
}

function extractSourceTitles(raw: Record<string, unknown>) {
  const payload = (raw.payload || raw) as Record<string, any>;
  const orderItems = payload?.order?.order_items || payload?.order?.item_list || payload?.data?.items || payload?.data?.item_list || payload?.items || [];
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
function isFlexShipping(shipping: Record<string, any>) {
  return shipping.logistic_type === "self_service"
    || shipping.logistic?.type === "self_service"
    || shipping.shipping_mode === "flex"
    || shipping.tags?.includes?.("flex");
}
function compareSales(left: Sale, right: Sale) {
  const leftDeferred = deferredShipping(left);
  const rightDeferred = deferredShipping(right);
  const leftGroup = leftDeferred ? 0 : saleShippingAction(left) ? 1 : 2;
  const rightGroup = rightDeferred ? 0 : saleShippingAction(right) ? 1 : 2;
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (leftDeferred && rightDeferred && leftDeferred.timestamp !== rightDeferred.timestamp) {
    return rightDeferred.timestamp - leftDeferred.timestamp;
  }
  return saleTimestamp(right) - saleTimestamp(left);
}
function compareSaleRows(left: SaleGridRow, right: SaleGridRow) {
  if (left.sortGroup !== right.sortGroup) return left.sortGroup - right.sortGroup;
  if (left.sortGroup === 0) {
    if (left.shopRank !== right.shopRank) return left.shopRank - right.shopRank;
    if (left.flex !== right.flex) return left.flex ? -1 : 1;
    return left.saleTimestamp - right.saleTimestamp;
  }
  if (left.sortGroup === 1 && left.deferredTimestamp !== right.deferredTimestamp) {
    return left.deferredTimestamp - right.deferredTimestamp;
  }
  return right.saleTimestamp - left.saleTimestamp;
}
function saleShopRank(marketplace: string, nickname: string) {
  const name = nickname.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const owner = name.includes("giseli") ? 0 : name.includes("edivaldo") ? 1 : 2;
  if (marketplace === "mercado_livre") return owner < 2 ? owner : 8;
  if (marketplace === "shopee") return owner < 2 ? 2 + owner : 9;
  return 9;
}
function saleTimestamp(sale: Sale) {
  const value = new Date(sale.data_venda || sale.created_at).getTime();
  return Number.isFinite(value) ? value : 0;
}
function extractShippingHistory(raw: Record<string, unknown>) {
  const payload = (raw.payload || raw) as Record<string, any>;
  const history = Array.isArray(payload.shipmentHistory)
    ? payload.shipmentHistory
    : Array.isArray(payload.shopeeHistory) ? payload.shopeeHistory : [];
  return [...history]
    .sort((a: Record<string, any>, b: Record<string, any>) => new Date(String(a.date || "")).getTime() - new Date(String(b.date || "")).getTime())
    .map((event: Record<string, any>) => ({
      date: dateTime(String(event.date || "")),
      status: shippingStatusLabel(String(event.status || ""), String(event.substatus || "")),
      description: event.description && event.source === "shopee_tracking"
        ? String(event.description)
        : shippingEventDescription(String(event.status || ""), String(event.substatus || ""))
    }));
}
function shippingStatusLabel(status: string, substatus: string) {
  const normalized = String(substatus || status).toUpperCase();
  const shopee: Record<string, string> = {
    LOGISTICS_NOT_START: "Aguardando início", LOGISTICS_READY: "Pronto para envio",
    LOGISTICS_REQUEST_CREATED: "Coleta solicitada", LOGISTICS_PICKUP_PENDING: "Aguardando coleta",
    LOGISTICS_PICKUP_RETRY: "Nova tentativa de coleta", LOGISTICS_PICKUP_DONE: "Coletado",
    LOGISTICS_PICKUP_FAILED: "Falha na coleta", LOGISTICS_PARCEL_RECEIVED: "Recebido pela transportadora",
    LOGISTICS_TRANSPORTING: "Em trânsito", LOGISTICS_DELIVERING: "Saiu para entrega",
    LOGISTICS_DELIVERY_DONE: "Entregue", LOGISTICS_DELIVERY_FAILED: "Falha na entrega",
    LOGISTICS_REQUEST_CANCELED: "Envio cancelado", LOGISTICS_COD_REJECTED: "Pagamento recusado",
    LOGISTICS_LOST: "Pacote extraviado", LOGISTICS_INVALID: "Envio inválido", LOGISTICS_UNKNOWN: "Situação desconhecida"
  };
  if (shopee[normalized]) return shopee[normalized];
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
  const shopeeDescriptions: Record<string, string> = {
    LOGISTICS_NOT_START: "Aguardando o início do processo logístico.", LOGISTICS_READY: "O pacote está pronto para envio.",
    LOGISTICS_REQUEST_CREATED: "A solicitação de coleta foi criada.", LOGISTICS_PICKUP_PENDING: "A transportadora ainda fará a coleta.",
    LOGISTICS_PICKUP_RETRY: "A transportadora fará uma nova tentativa de coleta.", LOGISTICS_PICKUP_DONE: "A transportadora coletou o pacote.",
    LOGISTICS_PICKUP_FAILED: "A tentativa de coleta não foi concluída.", LOGISTICS_PARCEL_RECEIVED: "A transportadora recebeu o pacote.",
    LOGISTICS_TRANSPORTING: "O pacote está em trânsito.", LOGISTICS_DELIVERING: "O pacote saiu para entrega.",
    LOGISTICS_DELIVERY_DONE: "O pacote foi entregue.", LOGISTICS_DELIVERY_FAILED: "A tentativa de entrega não foi concluída.",
    LOGISTICS_REQUEST_CANCELED: "O envio foi cancelado.", LOGISTICS_COD_REJECTED: "O pagamento na entrega foi recusado.",
    LOGISTICS_LOST: "A transportadora informou o extravio do pacote.", LOGISTICS_INVALID: "A situação logística foi marcada como inválida.",
    LOGISTICS_UNKNOWN: "A Shopee não detalhou a situação logística."
  };
  const normalized = String(substatus || status).toUpperCase();
  if (shopeeDescriptions[normalized]) return shopeeDescriptions[normalized];
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

function isUnpaidSale(sale: Sale) {
  const status = String(sale.status_venda?.internal_status || sale.status_original || "").toLowerCase();
  return ["aguardando_pagamento", "nao_paga", "payment_required", "payment_in_process", "unpaid"].includes(status);
}
