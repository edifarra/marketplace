"use client";

import { useState } from "react";

export type LogGridRow = {
  id: string;
  date: string;
  process: string;
  status: string;
  summary: string;
};

export function LogGrid({ rows }: { rows: LogGridRow[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const firstIndex = rows.length === 0 ? 0 : (currentPage - 1) * pageSize;
  const lastIndex = Math.min(rows.length, firstIndex + pageSize);
  const visibleRows = rows.slice(firstIndex, lastIndex);

  function toggle(id: string) {
    setExpandedId((current) => current === id ? null : id);
  }

  return (
    <div className="log-grid-container">
      <PaginationControls
        page={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        first={firstIndex}
        last={lastIndex}
        total={rows.length}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size);
          setPage(1);
          setExpandedId(null);
        }}
      />
      <div className="table-wrap">
        <table className="log-grid">
          <thead>
            <tr>
              <th>Data/hora</th>
              <th>Processo</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={3}>Nenhum log encontrado.</td></tr>
            ) : visibleRows.map((row) => {
              const expanded = expandedId === row.id;
              return (
                <LogGridEntry key={row.id} row={row} expanded={expanded} onToggle={() => toggle(row.id)} />
              );
            })}
          </tbody>
        </table>
      </div>
      <PaginationControls
        page={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        first={firstIndex}
        last={lastIndex}
        total={rows.length}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size);
          setPage(1);
          setExpandedId(null);
        }}
      />
    </div>
  );
}

function PaginationControls({ page, totalPages, pageSize, first, last, total, onPage, onPageSize }: {
  page: number;
  totalPages: number;
  pageSize: number;
  first: number;
  last: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  return (
    <div className="log-pagination">
      <label>
        Registros por página
        <select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
          {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <span className="log-pagination-count">
        Registros {total === 0 ? 0 : first + 1}–{last} de {total} registros
      </span>
      <div className="log-pagination-actions" aria-label="Navegação dos logs">
        <button type="button" className="secondary compact" disabled={page <= 1} onClick={() => onPage(1)}>Primeiro</button>
        <button type="button" className="secondary compact" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
        <span>Página {page} de {totalPages}</span>
        <button type="button" className="secondary compact" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Próximo</button>
        <button type="button" className="secondary compact" disabled={page >= totalPages} onClick={() => onPage(totalPages)}>Último</button>
      </div>
    </div>
  );
}

function LogGridEntry({ row, expanded, onToggle }: {
  row: LogGridRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`log-grid-row${expanded ? " expanded" : ""}`}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td>{row.date}</td>
        <td><span className="log-process"><span className="log-chevron" aria-hidden="true">›</span>{row.process}</span></td>
        <td><span className={`status log-status ${statusClass(row.status)}`}>{row.status}</span></td>
      </tr>
      {expanded ? (
        <tr className="log-summary-row">
          <td colSpan={3}>
            <div className="log-summary" aria-label={`Resumo de ${row.process}`}>
              <strong>Resumo</strong>
              <div>{row.summary || "Sem resumo."}</div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "executado" || normalized === "concluido") return "success";
  if (normalized === "executando") return "running";
  return "error";
}
