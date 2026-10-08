"use client";
import { useLayoutEffect, useRef } from "react";
import { caseDate } from "./case-display";
import { humanLabel, timelineFields } from "./case-presentation";
import { shopeeTimeline } from "./shopee-presentation";
import styles from "./cases.module.css";
type Row = Record<string, any>;
export function CaseTimeline({ row, events, deadlines = [] }: { row: Row; events: Row[]; deadlines?: Row[] }) {
  const scroll = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const followEnd = useRef(true);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    if (!initialized.current || followEnd.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    initialized.current = true;
  }, [events]);
  const shopee = row.marketplace === "shopee" ? shopeeTimeline(row, events, deadlines) : null;
  return <section className={`${styles.detailCard} ${styles.timelinePanel}`} aria-label="Timeline do caso"><h2>Timeline</h2>
    {shopee ? <><ol className={styles.compactTimeline}>{shopee.steps.map(step => <li key={step.label} data-progress={step.progress} aria-current={step.progress === "current" ? "step" : undefined}><span aria-hidden="true" className={styles.stepDot}>{step.progress === "complete" ? "✓" : step.progress === "unknown" ? "?" : "○"}</span><div><span>{step.label}</span><small>{({ complete: "Concluída", current: "Atual", pending: "Pendente", unknown: "Sem confirmação" })[step.progress]}</small>{step.date && <time>{step.dateLabel}: {caseDate(step.date)}</time>}</div></li>)}</ol>{shopee.ambiguous && <p className="muted">O estado disponível não confirma a etapa atual. Postagem e validação não foram presumidas.</p>}</> : !events.length ? <><p className="muted">Ainda não há eventos estruturados para este Caso.</p><p className="muted">Eventos futuros aparecerão aqui conforme forem persistidos.</p></> : <div className={styles.eventTimeline} ref={scroll} tabIndex={0} role="region" aria-label="Eventos do caso em ordem cronológica" onScroll={() => { const node = scroll.current; if (node) followEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>{events.map(event => <div key={event.id} className={styles.timelineEvent}><time>{caseDate(event.official_at || event.observed_at)}</time><div><span>{humanLabel(event.event_type) || "Situação atualizada"}</span>{timelineFields(event.state || {}).map(([label, value]) => <span key={label}>{label}: {value}</span>)}</div></div>)}</div>}
  </section>;
}
