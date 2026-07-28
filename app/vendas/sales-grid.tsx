"use client";

import Image from "next/image";
import { useState } from "react";

export type SaleGridRow = {
  id: string;
  date: string;
  marketplaceCode: string;
  marketplace: string;
  nickname: string;
  totalItems: number;
  value: string;
  status: string;
  flex: boolean;
  shippingAction: "print_label" | "emit_dce" | "arrange_shipment" | null;
  details: Array<{ label: string; value: string }>;
  items: Array<{ sku: string; description: string; quantity: number; unitValue: string; totalValue: string }>;
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
        <thead><tr><th>Data/hora</th><th>Marketplace</th><th>NickName da Loja</th><th>Itens</th><th>Valor da Venda</th><th>Status</th><th>Ação</th></tr></thead>
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
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  async function prepareShipping(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const labelWindow = window.open("", "_blank");
    setWorking(true);
    setActionError("");
    try {
      const response = await fetch(`/api/vendas/${row.id}/preparar-envio`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível preparar o envio.");
      if (result.labelUrl) {
        if (labelWindow) labelWindow.location.href = result.labelUrl;
        else window.open(result.labelUrl, "_blank", "noopener,noreferrer");
      }
      window.location.reload();
    } catch (error) {
      labelWindow?.close();
      setActionError(error instanceof Error ? error.message : "Não foi possível preparar o envio.");
      setWorking(false);
    }
  }
  return <>
    <tr className={`log-grid-row${expanded ? " expanded" : ""}`} onClick={onToggle} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); }
    }} role="button" tabIndex={0} aria-expanded={expanded}>
      <td>{row.date}</td>
      <td><span className="log-process"><span className="log-chevron">›</span><Image className="marketplace-mini-logo" src={marketplaceIcon(row.marketplaceCode)} width={25} height={25} alt="" />{row.marketplace}{row.flex && <span className="flex-badge" title="Mercado Envios Flex">Flex</span>}</span></td>
      <td>{row.nickname}</td><td>{row.totalItems}</td><td>{row.value}</td><td><span className="status">{row.status}</span></td>
      <td>
        {row.shippingAction === "print_label" && <a className="secondary compact link-button sale-label-button" href={`/api/vendas/${row.id}/etiqueta`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Imprimir etiqueta</a>}
        {row.shippingAction === "emit_dce" && <button className="secondary compact sale-label-button" disabled={working} onClick={prepareShipping}>{working ? "Emitindo..." : "Emitir DC-e"}</button>}
        {row.shippingAction === "arrange_shipment" && <button className="secondary compact sale-label-button" disabled={working} onClick={prepareShipping}>{working ? "Organizando..." : "Organizar envio"}</button>}
        {actionError && <div className="sale-action-error" title={actionError}>{actionError}</div>}
      </td>
    </tr>
    {expanded && <tr className="log-summary-row"><td colSpan={7}>
      <div className="sale-details">
        <strong>Detalhes da venda</strong>
        <dl>{row.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>
        <strong>Itens</strong>
        <div className="table-wrap"><table className="sale-items"><thead><tr><th>SKU</th><th>Descrição do produto</th><th>Quantidade</th><th>Valor unitário</th><th>Valor total</th></tr></thead>
          <tbody>{row.items.length ? row.items.map((item, index) => <tr key={`${item.sku}-${index}`}><td>{item.sku}</td><td>{item.description}</td><td>{item.quantity}</td><td>{item.unitValue}</td><td>{item.totalValue}</td></tr>) : <tr><td colSpan={5}>Itens não informados.</td></tr>}</tbody>
        </table></div>
        <strong>Histórico do envio</strong>
        {row.shippingHistory.length ? <div className="shipping-timeline">{row.shippingHistory.map((event, index) =>
          <div className="shipping-event" key={`${event.date}-${event.status}-${index}`}>
            <time>{event.date}</time><div><strong>{event.status}</strong><span>{event.description}</span></div>
          </div>
        )}</div> : <div className="muted">Histórico de envio ainda não informado pelo marketplace.</div>}
      </div>
    </td></tr>}
  </>;
}

function marketplaceIcon(marketplace: string) {
  return marketplace === "shopee" ? "/marketplaces/shopee.svg" : "/marketplaces/mercado-livre.svg";
}
