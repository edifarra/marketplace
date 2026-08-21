"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export type SaleGridRow = {
  id: string;
  date: string;
  marketplaceCode: string;
  marketplace: string;
  nickname: string;
  totalItems: number;
  inventoryAudit: {
    status: "success" | "error";
    title: string;
    items: Array<{ sku: string; status: "success" | "error"; message: string; physical: number; available: number; activeReservations: number; expectedAvailable: number }>;
  };
  value: string;
  status: string;
  unpaid: boolean;
  shippingOverdue: boolean;
  flex: boolean;
  shippingAction: "print_label" | "emit_dce" | "arrange_shipment" | null;
  shippingActionText: string | null;
  sortGroup: number;
  shopRank: number;
  saleTimestamp: number;
  deferredTimestamp: number;
  details: Array<{ label: string; value: string }>;
  customer: { name: string };
  deliveryCode: string;
  items: Array<{ sku: string; description: string; variations: string[]; quantity: number; unitValue: string; totalValue: string; imageUrl: string }>;
  shippingHistory: Array<{ date: string; status: string; description: string }>;
};

export function SalesGrid({ rows }: { rows: SaleGridRow[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const first = rows.length ? (currentPage - 1) * pageSize : 0;
  const last = Math.min(rows.length, first + pageSize);

  const pagination = (
    <div className="log-pagination">
      <label>Registros por página
        <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); setExpandedId(null); }}>
          {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <span className="log-pagination-count">Registros {rows.length ? first + 1 : 0}–{last} de {rows.length} registros</span>
      <div className="log-pagination-actions" aria-label="Navegação das vendas">
        <button className="secondary compact" disabled={currentPage <= 1} onClick={() => setPage(1)}>Primeiro</button>
        <button className="secondary compact" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Anterior</button>
        <span>Página {currentPage} de {totalPages}</span>
        <button className="secondary compact" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Próximo</button>
        <button className="secondary compact" disabled={currentPage >= totalPages} onClick={() => setPage(totalPages)}>Último</button>
      </div>
    </div>
  );

  return <div className="log-grid-container">
    {pagination}
    <div className="table-wrap">
      <table className="log-grid sales-grid">
        <thead><tr><th>Data/hora</th><th>Marketplace</th><th>NickName da Loja</th><th>Itens / Estoque</th><th>Valor da Venda</th><th>Status</th><th>Ação</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={7}>Nenhuma venda encontrada.</td></tr> :
            rows.slice(first, last).map((row) => {
              const expanded = row.id === expandedId;
              return <SaleEntry key={row.id} row={row} expanded={expanded} onToggle={() => setExpandedId(expanded ? null : row.id)} />;
            })}
        </tbody>
      </table>
    </div>
    {pagination}
  </div>;
}

function SaleEntry({ row, expanded, onToggle }: { row: SaleGridRow; expanded: boolean; onToggle: () => void }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [processed, setProcessed] = useState(false);
  const [actionError, setActionError] = useState("");
  useEffect(() => { setProcessed(localStorage.getItem(`sale-label-opened:${row.id}`) === "1"); }, [row.id]);
  const markProcessed = () => { localStorage.setItem(`sale-label-opened:${row.id}`, "1"); setProcessed(true); };
  async function prepareShipping(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const labelWindow = window.open("", "_blank");
    setWorking(true);
    setActionError("");
    try {
      const response = await fetch(`/api/vendas/${row.id}/preparar-envio`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível preparar o envio.");
      await new Promise((resolve) => setTimeout(resolve, Number(result.waitMs || 4000)));
      if (result.labelUrl) {
        const labelUrl = await waitForLabel(String(result.labelUrl));
        if (labelWindow) labelWindow.location.href = labelUrl;
        else window.open(labelUrl, "_blank", "noopener,noreferrer");
      }
      markProcessed();
      router.refresh();
      setWorking(false);
    } catch (error) {
      labelWindow?.close();
      setActionError(error instanceof Error ? error.message : "Não foi possível preparar o envio.");
      setWorking(false);
    }
  }
  async function printLabel(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const labelWindow = window.open("", "_blank");
    setWorking(true);
    setActionError("");
    try {
      const labelUrl = await waitForLabel(`/api/vendas/${row.id}/etiqueta`);
      if (labelWindow) labelWindow.location.href = labelUrl;
      else window.open(labelUrl, "_blank", "noopener,noreferrer");
      markProcessed();
      router.refresh();
    } catch (error) {
      labelWindow?.close();
      setActionError(error instanceof Error ? error.message : "Não foi possível imprimir a etiqueta.");
    } finally {
      setWorking(false);
    }
  }
  return <>
    <tr className={`log-grid-row${expanded ? " expanded" : ""}${row.shippingOverdue ? " sale-overdue" : processed ? " sale-processed" : ""}`} onClick={onToggle} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); }
    }} role="button" tabIndex={0} aria-expanded={expanded}>
      <td>{row.date}</td>
      <td><span className="log-process"><span className="log-chevron">›</span><Image className="marketplace-mini-logo" src={marketplaceIcon(row.marketplaceCode)} width={25} height={25} alt="" />{row.marketplace}{row.flex && <span className="flex-badge" title="Mercado Envios Flex">Flex</span>}</span></td>
      <td>{row.nickname}</td><td><span className="sale-items-audit"><span>{row.totalItems}</span><span className={`inventory-box ${row.inventoryAudit.status}`} title={row.inventoryAudit.title} role="img" aria-label={row.inventoryAudit.title}>📦</span></span></td><td>{row.value}</td><td><span className={`status${row.unpaid ? " unpaid" : ""}`}>{row.status}</span></td>
      <td>
        {row.shippingAction === "print_label" && <button className={`secondary compact sale-label-button${working ? " processing" : ""}`} disabled={working} onClick={printLabel}>{working ? "Gerando…" : "Imprimir etiqueta"}</button>}
        {!processed && row.shippingAction === "emit_dce" && <button className={`secondary compact sale-label-button${working ? " processing" : ""}`} disabled={working} onClick={prepareShipping}>{working ? "Emitindo…" : "Emitir DC-e"}</button>}
        {!processed && row.shippingAction === "arrange_shipment" && <button className={`secondary compact sale-label-button${working ? " processing" : ""}`} disabled={working} onClick={prepareShipping}>{working ? "Organizando…" : "Organizar envio"}</button>}
        {row.shippingActionText && <span className="muted">{row.shippingActionText}</span>}
        {actionError && <div className="sale-action-error" title={actionError}>{actionError}</div>}
      </td>
    </tr>
    {expanded && <tr className={`log-summary-row${row.shippingOverdue ? " sale-overdue" : processed ? " sale-processed" : ""}`}><td colSpan={7}>
      <div className="sale-details">
        <strong>Itens</strong>
        <div className="sale-item-list">{row.items.length ? row.items.map((item, index) => {
          const audit = row.inventoryAudit.items.find((entry) => entry.sku === item.sku);
          return <article className="sale-item-card" key={`${item.sku}-${index}`}>
            <div className="sale-item-values">
              <div><span>SKU</span><strong>{item.sku}</strong></div>
              <div className="sale-item-description"><span>Descrição do produto</span><strong>{item.description}</strong>{item.variations.map((variation) => <span className="sale-item-variation" key={variation}>{variation}</span>)}</div>
              <div><span>Quantidade</span><strong>{item.quantity}</strong></div>
              <div><span>Valor unitário</span><strong>{item.unitValue}</strong></div>
              <div><span>Valor total</span><strong>{item.totalValue}</strong></div>
            </div>
            <div className="sale-item-audit">{audit ? <><strong>{audit.sku}</strong><span>{audit.message}</span><small>Físico: {audit.physical} · Disponível: {audit.available} · Reservas ativas: {audit.activeReservations} · Disponível esperado: {audit.expectedAvailable}</small></> : <><strong>{item.sku}</strong><span>Auditoria de estoque não informada.</span></>}</div>
            <div className="sale-item-cover">{item.imageUrl ? <img src={item.imageUrl} alt={`Foto 1 do produto ${item.sku}`} /> : <span>Sem foto</span>}</div>
          </article>;
        }) : <div className="muted">Itens não informados.</div>}</div>
        <div className="sale-detail-columns">
          <section><strong>Histórico de Envio</strong><dl className="sale-delivery-code"><div><dt>Código da Entrega</dt><dd>{row.deliveryCode}</dd></div></dl>
            {row.shippingHistory.length ? <div className="shipping-timeline">{row.shippingHistory.map((event, index) => <div className="shipping-event" key={`${event.date}-${event.status}-${index}`}><time>{event.date}</time><div><strong>{event.status}</strong><span>{event.description}</span></div></div>)}</div> : <div className="muted">Histórico de envio ainda não informado pelo marketplace.</div>}
          </section>
          <section><strong>Detalhes da venda</strong><dl>{row.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>
            <div className="sale-customer-details"><strong>Cliente</strong><dl>
              <div><dt>Nome do cliente</dt><dd className="sale-customer-name">{row.customer.name}</dd></div>
            </dl></div>
          </section>
        </div>
        <div className={`inventory-audit-summary ${row.inventoryAudit.status}`}>
          <span className="inventory-box" aria-hidden="true">📦</span>
          <div><strong>{row.inventoryAudit.status === "success" ? "Estoque conferido" : "Falha na auditoria do estoque"}</strong><span>{row.inventoryAudit.title}</span></div>
          <div className="inventory-audit-actions">
            {row.items.map((item) => <a className="secondary compact" href={`/historico-estoque?busca=${encodeURIComponent(item.sku)}`} key={item.sku}>Estoque</a>)}
          </div>
        </div>
      </div>
    </td></tr>}
  </>;
}

async function waitForLabel(url: string) {
  let lastMessage = "A etiqueta ainda está sendo processada pelo marketplace.";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(url, { cache: "no-store" });
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && (contentType.includes("pdf") || contentType.includes("octet-stream"))) {
      return URL.createObjectURL(await response.blob());
    }
    const body = await response.text();
    try { lastMessage = JSON.parse(body).error || lastMessage; } catch { /* resposta HTML de processamento */ }
    if (response.status !== 409 || attempt === 7) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(lastMessage);
}

function marketplaceIcon(marketplace: string) {
  return marketplace === "shopee" ? "/marketplaces/shopee.svg" : "/marketplaces/mercado-livre.svg";
}
