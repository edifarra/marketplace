"use client";

import { Fragment, useState } from "react";
import { saveSaleStatusMapping } from "./actions";

const INTERNAL_STATUSES = [
  ["aguardando_pagamento", "Aguardando pagamento"],
  ["pagamento_em_processamento", "Pagamento em processamento"],
  ["paga", "Paga"],
  ["pronta_para_envio", "Pronta para envio"],
  ["a_caminho", "A caminho"],
  ["saiu_para_entrega", "Saiu para entrega"],
  ["entregue", "Entregue"],
  ["concluida", "Concluída"],
  ["cancelada", "Cancelada"],
  ["reembolsada", "Reembolsada"],
  ["devolucao_solicitada", "Devolução solicitada"],
  ["cancelamento_solicitado", "Cancelamento solicitado"]
] as const;

type MappingRow = {
  id: string;
  external_status: string;
  internal_status: string;
  description: string | null;
  reserves_stock: boolean;
  deducts_physical_stock: boolean;
  releases_stock: boolean;
  final_status: boolean;
};

export function StatusMappingsTable({ rows, marketplace }: { rows: MappingRow[]; marketplace: string }) {
  const groups = groupRows(rows);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(status: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
  }

  return <div className="table-wrap">
    <table className="status-mapping-table grouped">
      <thead><tr>
        <th>Status</th><th>Status no sistema e descrição</th><th>Regras de estoque</th><th>Ação</th>
      </tr></thead>
      <tbody>
        {groups.length === 0 && <tr><td colSpan={4}>Nenhum status encontrado para este marketplace.</td></tr>}
        {groups.map((group) => {
          const open = expanded.has(group.status);
          const primary = group.parent || group.children[0];
          return <Fragment key={group.status}>
            <MappingEditorRow
              row={primary}
              marketplace={marketplace}
              statusLabel={group.status}
              childCount={group.children.length}
              expanded={open}
              onToggle={group.children.length ? () => toggle(group.status) : undefined}
              applyToSubstatuses={Boolean(group.parent && group.children.length)}
            />
            {open && group.children.map((child) => <MappingEditorRow
              key={child.id}
              row={child}
              marketplace={marketplace}
              statusLabel={child.external_status.split("::")[1] || child.external_status}
              substatus
            />)}
          </Fragment>;
        })}
      </tbody>
    </table>
  </div>;
}

function MappingEditorRow({ row, marketplace, statusLabel, childCount = 0, expanded = false, onToggle, substatus = false, applyToSubstatuses = false }: {
  row: MappingRow; marketplace: string; statusLabel: string; childCount?: number; expanded?: boolean;
  onToggle?: () => void; substatus?: boolean; applyToSubstatuses?: boolean;
}) {
  const formId = `status-mapping-${row.id}`;
  return <tr className={substatus ? "status-substatus-row" : "status-parent-row"}>
    <td>
      {onToggle ? <button className="status-expand-button" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="status-expand-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
        <span><code>{statusLabel}</code><small>{childCount} substatus</small></span>
      </button> : <div className={substatus ? "status-substatus-label" : "status-static-label"}>
        {substatus && <span className="status-tree-line" aria-hidden="true">└</span>}<code>{statusLabel}</code>
      </div>}
    </td>
    <td><div className="status-mapping-fields">
      <select form={formId} name="internal_status" defaultValue={canonicalStatus(row.internal_status)}>
        {INTERNAL_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input form={formId} name="description" defaultValue={row.description || ""} aria-label="Descrição exibida" placeholder="Descrição exibida" required />
    </div></td>
    <td><div className="status-mapping-rules">
      <label><input form={formId} type="checkbox" name="reserves_stock" defaultChecked={row.reserves_stock} /><span>Reserva disponível</span></label>
      <label><input form={formId} type="checkbox" name="deducts_physical_stock" defaultChecked={row.deducts_physical_stock} /><span>Baixa estoque físico</span></label>
      <label><input form={formId} type="checkbox" name="releases_stock" defaultChecked={row.releases_stock} /><span>Libera reserva</span></label>
      <label><input form={formId} type="checkbox" name="final_status" defaultChecked={row.final_status} /><span>Status final</span></label>
      {applyToSubstatuses && <label title="Replica esta configuração para todos os substatus deste status">
        <input form={formId} type="checkbox" name="apply_to_substatuses" /><span>Aplicar aos substatus</span>
      </label>}
    </div></td>
    <td><form id={formId} action={saveSaleStatusMapping}>
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="marketplace" value={marketplace} />
      <button className="primary compact" type="submit">Salvar</button>
    </form></td>
  </tr>;
}

function groupRows(rows: MappingRow[]) {
  const groups = new Map<string, { status: string; parent?: MappingRow; children: MappingRow[] }>();
  for (const row of rows) {
    const [status, substatus] = row.external_status.split("::");
    const group = groups.get(status) || { status, children: [] };
    if (substatus) group.children.push(row); else group.parent = row;
    groups.set(status, group);
  }
  return [...groups.values()].sort((a, b) => a.status.localeCompare(b.status)).map((group) => ({
    ...group,
    children: group.children.sort((a, b) => a.external_status.localeCompare(b.external_status))
  }));
}

function canonicalStatus(value: string) {
  const aliases: Record<string, string> = { criada: "pronta_para_envio", nao_paga: "aguardando_pagamento", processada: "pronta_para_envio", enviada: "a_caminho" };
  const normalized = aliases[value] || value;
  return INTERNAL_STATUSES.some(([status]) => status === normalized) ? normalized : "paga";
}
