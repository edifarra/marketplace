"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { caseDate, caseImage, caseMoney, deadlineLabel, reputationLabel } from "./case-display";
import styles from "./cases.module.css";
type Row = Record<string, any>;
function Photo({ product }: { product: Row | null }) {
  const image = caseImage(product);
  return image ? <Image unoptimized width={66} height={66} src={image} alt={product?.title || "Produto"} loading="lazy"/> : <span className={styles.noImage}>Sem foto</span>;
}
export function CaseGrid({ rows, initialId }: { rows: Row[]; initialId?: string }) {
  const [expanded, setExpanded] = useState<string | null>(initialId && rows.some(r => r.id === initialId) ? initialId : null);
  return <div className={styles.list}>{rows.map(row => <article key={row.id} className={styles.case} data-case-id={row.id} data-external-case-id={row.external_case_id}>
    <button type="button" className={styles.caseRow} aria-expanded={expanded === row.id} aria-controls={`detail-${row.id}`} aria-label={`${expanded === row.id ? "Recolher" : "Expandir"} Caso ${row.external_case_id}`} onClick={() => setExpanded(current => current === row.id ? null : row.id)}>
      <span className={styles.marketplace}><Image unoptimized width={46} height={46} src={row.marketplace === "shopee" ? "/marketplaces/shopee-mini.webp" : "/marketplaces/mercado-livre-mini.png"} alt=""/><span><strong>{row.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}</strong><span className="muted">Loja {row.account?.name || row.account?.nickname || "Não informado"}</span></span></span>
      <span className={styles.sale}>{(row.items.length ? row.items : [{}]).map((item: Row, index: number) => <span className={styles.product} key={item.id || index}><Photo product={item.product}/><span><strong>Venda #{row.order_id || row.sale?.order_id || "Não informado"}</strong><span>{item.product?.title || "Produto não informado"}</span><small className="muted">SKU {item.sku || "—"} · Qtd. {item.quantidade ?? "—"} · {caseMoney(item.valor_total)}</small></span></span>)}</span>
      <span className={styles.caseBlock}><strong className={styles.caseTitle}>Caso #{row.external_case_id}</strong><span>Motivo: {row.reason || (row.reason_code ? `Código ${row.reason_code}` : "Não informado")}</span><span className={row.marketplace !== "shopee" && row.reputation_impact === "affected" ? styles.affected : row.marketplace !== "shopee" && row.reputation_impact === "not_affected" ? styles.positive : "muted"}>{reputationLabel(row)}</span></span>
      <span className={styles.situation}><span>Prazo: {row.deadlines.length ? row.deadlines.map(deadlineLabel).join("; ") : "Não informado"}</span><span>Precisa de ação: {row.needs_action === true ? "Sim (oficial)" : row.needs_action === false ? "Não (oficial)" : "Não informado"}</span><span>Última atualização local: {caseDate(row.updated_at)}</span><span className={`${styles.badge} ${styles[row.group]}`}>{row.groupLabel}</span></span>
      <span className={`${styles.chevron} ${expanded === row.id ? styles.rotated : ""}`} aria-hidden="true">⌄</span>
    </button>
    {expanded === row.id && <div id={`detail-${row.id}`} className={styles.expansion}><CaseDetail id={row.id}/></div>}
  </article>)}</div>;
}
function Field({ label, value }: { label: string; value: any }) {
  return <div><dt>{label}</dt><dd>{value == null || value === "" ? "Não informado" : String(value)}</dd></div>;
}
export function CaseDetail({ id }: { id: string }) {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const chat = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError("");
    fetch(`/api/central-reclamacoes/${id}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Não foi possível ler os detalhes locais do Caso.");
      const result = await response.json(); if (!controller.signal.aborted) setData(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id, retry]);
  useLayoutEffect(() => {
    if (!chat.current || !data) return;
    chat.current.scrollTop = anchor.current ? chat.current.scrollHeight - anchor.current.height + anchor.current.top : chat.current.scrollHeight;
    anchor.current = null;
  }, [data]);
  async function older() {
    if (!data || !data.messages.length || olderLoading) return;
    setOlderLoading(true); setError("");
    const first = data.messages[0];
    try {
      const response = await fetch(`/api/central-reclamacoes/${id}?${new URLSearchParams({ before: first.created_at, beforeId: first.id, beforeSent: first.sent_at || "null" })}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível ler as mensagens anteriores.");
      const result = await response.json();
      if (result.conversation?.id !== data.conversation?.id) throw new Error("O vínculo da conversa mudou. Reabra o Caso para consultar novamente.");
      if (chat.current) anchor.current = { height: chat.current.scrollHeight, top: chat.current.scrollTop };
      setData(current => current ? { ...current, messages: [...result.messages, ...current.messages], olderMessages: result.olderMessages } : null);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha na leitura local."); } finally { setOlderLoading(false); }
  }
  if (!data) return <div role="status">{error ? <><p role="alert">{error}</p><button type="button" className="secondary" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></> : "Carregando informações locais…"}</div>;
  const row = data.row;
  const logistics = row.reverse_logistics || {};
  const resolution = row.resolution || {};
  return <div className={styles.drilldown}>
    <section className={styles.chatPanel}><h2>Chat</h2><div className={styles.chatScroll} ref={chat} role="log" aria-label="Histórico local da conversa">
      {data.olderMessages && <button type="button" className="secondary" onClick={older} disabled={olderLoading}>{olderLoading ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {!data.conversation ? <p className="muted">Nenhuma conversa vinculada a este Caso.</p> : !data.messages.length ? <p className="muted">A conversa vinculada não tem mensagens locais disponíveis.</p> : data.messages.map((message: Row) => <div key={message.id} className={`chat-message ${["incoming", "outgoing"].includes(message.direction) ? message.direction : "system"}`}><strong>{message.sender_name || (message.direction === "outgoing" ? "Vendedor" : message.direction === "incoming" ? "Comprador" : "Sistema")}</strong><div className={styles.messageText}>{message.text || `${message.message_type || "Conteúdo"} — conteúdo textual não informado`}</div><small>{caseDate(message.sent_at || message.created_at)}</small></div>)}
    </div><p className={styles.readOnly}>Somente leitura · envio ainda não habilitado</p>{error && <p role="alert" className="form-error">{error}</p>}</section>
    <div className={styles.rightColumn}><section className={styles.detailCard}><h2>Gerais</h2><dl className={styles.generalFields}>
      <Field label="Marketplace" value={row.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}/><Field label="Conta" value={row.account?.name || row.account?.nickname}/><Field label="ID do Caso" value={row.external_case_id}/><Field label="Venda/pedido" value={row.order_id || row.sale?.order_id}/><Field label="Comprador" value={data.conversation?.buyer_name || data.conversation?.buyer_id}/>
      <Field label="Motivo" value={row.reason || row.reason_code}/><Field label="Descrição do comprador" value={row.buyer_description}/><Field label="Reputação oficial" value={reputationLabel(row)}/>
      <Field label="Solução/resolução" value={typeof row.resolution === "string" ? row.resolution : resolution.reason}/><Field label="Encerrado por" value={resolution.closed_by}/><Field label="Data da resolução" value={resolution.date_created ? caseDate(resolution.date_created) : null}/>
      <Field label="Logística reversa" value={logistics.status}/><Field label="Rastreio" value={logistics.tracking}/><Field label="Modalidade" value={logistics.modality}/><Field label="Prazos oficiais conhecidos" value={data.deadlines.length ? data.deadlines.map(deadlineLabel).join("; ") : null}/>
    </dl><div className={styles.detailProducts}>{(data.items.length ? data.items : [{}]).map((item: Row, i: number) => <div className={styles.product} key={item.id || i}><Photo product={item.product}/><div>{item.product?.title || "Produto: Não informado"}<div>SKU: {item.sku || "Não informado"}</div><div>Quantidade: {item.quantidade ?? "Não informado"} · Valor: {caseMoney(item.valor_total)}</div></div></div>)}</div></section>
      <section className={styles.detailCard}><h2>Timeline</h2>{!data.timeline.length ? <><p className="muted">Ainda não há eventos estruturados para este Caso.</p><p className="muted">Eventos futuros aparecerão aqui conforme forem persistidos.</p></> : <div className="shipping-timeline">{data.timeline.map((event: Row) => <div key={event.id} className="shipping-event"><time>{caseDate(event.official_at || event.observed_at)}</time><div><strong>{event.event_type}</strong>{Object.entries(event.state || {}).filter(([, value]) => value != null && value !== "unknown").map(([key, value]) => <span key={key}>{key}: {typeof value === "object" ? JSON.stringify(value) : String(value)}</span>)}</div></div>)}</div>}</section>
      <section className={styles.detailCard}><h2>Ações</h2>{!data.actions.length ? <p className="muted">Nenhuma ação oficial disponível no momento.</p> : <><p className="muted">Registro histórico · execução ainda não habilitada nesta etapa.</p><ul>{data.actions.map((action: Row) => <li key={action.id}>{action.action_code} · observado em {caseDate(action.observed_at)} · {action.mandatory === true ? "Obrigatória (oficial)" : action.mandatory === false ? "Opcional (oficial)" : "Obrigatoriedade não informada"}</li>)}</ul></>}</section>
    </div>
  </div>;
}
