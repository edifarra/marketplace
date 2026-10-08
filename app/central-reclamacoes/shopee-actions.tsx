"use client";
import { useState } from "react";
import { caseDate, caseMoney } from "./case-display";
import styles from "./cases.module.css";
type Row = Record<string, any>;
export function ShopeeActions({ row, deadlines, now }: { row: Row; deadlines: Row[]; now?: number }) {
  const [openedAt] = useState(() => Date.now());
  const closed = ["CLOSED", "CANCELLED"].includes(row.status);
  // Observed receiving context is not API execution eligibility. Execution stays disabled.
  const received = row.status === "PROCESSING" && row.validation_type === "seller_validation" && row.reverse_logistics?.status === "LOGISTICS_DELIVERY_DONE";
  const due = deadlines.filter(d => d.purpose === "seller_response" && d.responsible === "seller" && ["date", "timestamp"].includes(d.precision) && d.value)
    .sort((a,b) => String(a.value).localeCompare(String(b.value)))[0];
  const expired = due?.precision === "timestamp" && Number.isFinite(Date.parse(due.value)) && Date.parse(due.value) < (now ?? openedAt);
  return <div>
    {received && !closed && <div className={styles.actionButtons}><button type="button" className="secondary" disabled aria-describedby={`shopee-confirm-${row.id}`}>Finalizar sem disputa e reembolsar comprador</button></div>}
    {!closed && <p>Para disputa, acesse o site da Shopee.</p>}
    {due && <p>Prazo de resposta do vendedor: <time>{due.precision === "date" ? `${due.value} (sem horário informado)` : caseDate(due.value)}</time>{expired ? " · Prazo expirado" : due.precision === "date" ? " · Horário limite indisponível" : " · Prazo pendente"}</p>}
    {received && !closed ? <p id={`shopee-confirm-${row.id}`} className="muted">Execução indisponível: a compatibilidade da API para finalizar após receber a devolução física ainda não foi comprovada. Faça a operação no site da Shopee.{row.refund_amount != null && row.currency ? ` Valor solicitado: ${caseMoney(row.refund_amount, row.currency)}.` : ""}</p> : <p className="muted">{closed ? "Solicitação finalizada. Nenhuma ação operacional disponível." : "Os dados disponíveis não confirmam uma devolução recebida em validação pelo vendedor."}</p>}
    {!due && !closed && <p className="muted">Prazo de decisão indisponível nos dados locais.</p>}
  </div>;
}
