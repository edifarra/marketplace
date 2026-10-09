"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { ProductThumbnail } from "../components/product-thumbnail";
import { caseDate, caseMoney, caseReason, caseHeaderRow, claimDescription, sellerDeadline, caseStatusLabel, deadlineLabel, reputationLabel } from "./case-display";
import { caseAttention, caseContext } from "@/lib/marketplace-case-context";
import { ShopeeActions } from "./shopee-actions";
import { CaseTimeline } from "./case-timeline";
import { CaseEvidence } from "./case-evidence";
import { ClaimControls } from "./claim-controls";
import styles from "./cases.module.css";
import { detailCacheKey, readCaseCache, updateCaseCache } from "./case-detail-cache";
import { buyerFields, displayFields, humanLabel, presentValue, returnFields } from "./case-presentation";
type Row = Record<string, any>;
function Photo({ product }: { product: Row | null }) {
  const image = [...(product?.product_images || [])].sort((a, b) => a.position - b.position)[0];
  return <ProductThumbnail width={66} height={66} image={image} alt={product?.title || "Produto"} />;
}
export function CaseGrid({ rows, initialId, cacheScope = "", cacheRevision = "" }: { rows: Row[]; initialId?: string; cacheScope?: string; cacheRevision?: string }) {
  const [expanded, setExpanded] = useState<string | null>(initialId && rows.some(r => r.id === initialId) ? initialId : null);
  const [details, setDetails] = useState<Record<string, Row>>({});
  const onDetail = useCallback((detail: Row) => {
    setDetails(current => ({ ...current, [detail.row.id]: detail }));
  }, []);
  useEffect(() => { setDetails({}); }, [rows]);
  return <div className={styles.list}>{rows.map(initialRow => {
    const detail = details[initialRow.id];
    const row = caseHeaderRow(initialRow, detail);
    return <article key={row.id} className={styles.case} data-case-id={row.id} data-external-case-id={row.external_case_id}>
    <button type="button" className={styles.caseRow} aria-expanded={expanded === row.id} aria-controls={`detail-${row.id}`} aria-label={`${expanded === row.id ? "Recolher" : "Expandir"} Caso ${row.external_case_id}`} onClick={() => setExpanded(current => current === row.id ? null : row.id)}>
      <span className={styles.marketplace}><Image unoptimized width={46} height={46} src={row.marketplace === "shopee" ? "/marketplaces/shopee-mini.webp" : "/marketplaces/mercado-livre-mini.png"} alt=""/><span><strong>{row.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}</strong><span className="muted">Loja {row.account?.name || row.account?.nickname || "Não informado"}</span><small className="muted">Caso #{row.external_case_id}</small></span></span>
      <span className={styles.sale}>{(row.items.length ? row.items : [{}]).map((item: Row, index: number) => <span className={styles.product} key={item.id || index}><Photo product={item.product}/><span><strong>Venda #{row.order_id || row.sale?.order_id || "Não informado"}</strong><span>{item.product?.title || "Produto não informado"}</span><small className="muted">SKU {item.sku || "—"} · Qtd. {item.quantidade ?? "—"} · {caseMoney(item.valor_total)}</small></span></span>)}</span>
      <span className={styles.caseBlock}>{caseContext(row) === "return" && <>{presentValue(row.reverse_logistics?.contact_name) && <span>Nome logístico: {row.reverse_logistics.contact_name}</span>}{presentValue(row.reverse_logistics?.tracking) && <span>Código de retorno: {row.reverse_logistics.tracking}</span>}</>}{caseReason(row) && <span>Motivo: {caseReason(row)}</span>}{reputationLabel(row) && <span className={row.marketplace !== "shopee" && row.reputation_impact === "affected" ? styles.affected : row.marketplace !== "shopee" && row.reputation_impact === "not_affected" ? styles.positive : "muted"}>{reputationLabel(row)}</span>}</span>
      <span className={styles.situation}><span>{caseStatusLabel(row)}</span>{row.marketplace === "mercado_livre" ? sellerDeadline(row,row.deadlines) && <span>Prazo: <strong className={styles.deadline}>{caseDate(sellerDeadline(row,row.deadlines))}</strong></span> : row.deadlines.length > 0 && <span>Prazo: {row.deadlines.map(deadlineLabel).join("; ")}</span>}<span>Precisa de ação: {caseAttention(row) === "ACTION_REQUIRED" ? "Sim" : "Não"}</span><span>Última atualização local: {caseDate(row.updated_at)}</span><span className={`${styles.badge} ${styles[row.group]}`}>{row.groupLabel}</span></span>
      <span className={`${styles.chevron} ${expanded === row.id ? styles.rotated : ""}`} aria-hidden="true">⌄</span>
    </button>
    {expanded === row.id && <div id={`detail-${row.id}`} className={styles.expansion}><CaseDetail id={row.id} initialRow={initialRow} cacheScope={cacheScope} cacheRevision={cacheRevision} onDetail={onDetail} showHeader={false}/></div>}
  </article>; })}</div>;
}
function Field({ label, value }: { label: string; value: any }) {
  if (!presentValue(value)) return null;
  return <div><dt>{label}</dt><dd className={label === "Prazo vendedor" ? styles.sellerDeadline : undefined}>{presentValue(value)}</dd></div>;
}
export function CaseDetail({ id, onDetail, showHeader = true, initialRow, initialData, cacheScope = "", cacheRevision = "" }: { id: string; onDetail?: (detail: Row) => void; showHeader?: boolean; initialRow?: Row; initialData?: Row; cacheScope?: string; cacheRevision?: string }) {
  const [data, setData] = useState<Row | null>(initialData || null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const chat = useRef<HTMLDivElement>(null);
  const loadedId = useRef<string | null>(initialData ? id : null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const cacheKey = detailCacheKey(cacheScope, cacheRevision, initialRow || { id });
  const changeDetail = useCallback((value: Row) => { updateCaseCache(cacheKey, value); setData(value); }, [cacheKey]);
  useEffect(() => {
    let active = true;
    if (loadedId.current !== id) { setData(null); loadedId.current = id; }
    setError("");
    if (initialData && retry === 0) updateCaseCache(cacheKey, initialData, false);
    readCaseCache(cacheKey, id).then(result => { if (active) setData(result); }).catch(e => { if (active) setError(e.message); });
    const refresh = () => setRetry(n => n + 1);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [id, retry, cacheKey, initialData]);
  useEffect(() => { if (data) onDetail?.(data); }, [data, onDetail]);
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
  const isClaim = row.marketplace === "mercado_livre" && row.case_type === "claim";
  const buyer = row.buyer_data || {};
  const buyerDisplay = buyerFields(row);
  const resolution = row.resolution || {};
  return <div className={styles.drilldown}>
    {showHeader && <header className={styles.detailHeader}><h2>{row.marketplace === "shopee" ? "Shopee" : "Mercado Livre"} · Caso #{row.external_case_id}</h2>{caseReason(row) && <p>Motivo: {caseReason(row)}</p>}</header>}
    <section className={styles.chatPanel}><h2>{data.messageScope === "case" ? "Mensagens do caso" : "Histórico normal — contexto do pedido"}</h2><div className={styles.chatScroll} ref={chat} role="log" aria-label="Histórico local da conversa">{data.messageScope === "order_context" && <p className="muted">Este histórico pertence ao chat normal do pedido. As mensagens não foram classificadas como mensagens da devolução.</p>}{isClaim && <div className={styles.claimContext}><strong>{row.status === "closed" ? "Reclamação encerrada" : "Reclamação aberta"} nº {row.external_case_id}{row.reputation_impact === "not_affected" ? " · Não afetou sua reputação" : row.reputation_impact === "affected" ? " · Afeta sua reputação" : ""}</strong>{caseReason(row) && <p>Motivo: {caseReason(row)}</p>}{claimDescription(row) && <p>Descrição: {claimDescription(row)}</p>}</div>}{row.marketplace === "shopee" && <section className={styles.claimContext} aria-label="Solicitado pelo comprador"><h3>Solicitado pelo comprador</h3><dl className={styles.generalFields}><Field label="Reembolso solicitado" value={row.refund_amount != null ? row.currency ? caseMoney(row.refund_amount, row.currency) : `${row.refund_amount} (moeda não informada)` : "Não disponível nos dados locais"}/><Field label="Motivo da devolução" value={caseReason(row) || row.reason_code || "Não disponível nos dados locais"}/><Field label="Descrição do comprador" value={row.buyer_description || "Não disponível nos dados locais"}/></dl><CaseEvidence evidence={data.evidence || []}/></section>}
      {data.olderMessages && <button type="button" className="secondary" onClick={older} disabled={olderLoading}>{olderLoading ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {!data.conversation ? <p className="muted">Nenhuma conversa vinculada a este Caso.</p> : !data.messages.length ? <p className="muted">A conversa vinculada não tem mensagens locais disponíveis.</p> : data.messages.map((message: Row) => <div key={message.id} className={`chat-message ${["incoming", "outgoing"].includes(message.direction) ? message.direction : "system"}`}><strong>{message.sender_name || (message.direction === "outgoing" ? "Vendedor" : message.direction === "incoming" ? "Comprador" : "Sistema")}</strong><div className={styles.messageText}>{message.text || `${message.message_type || "Conteúdo"} — conteúdo textual não informado`}</div><small>{caseDate(message.sent_at || message.created_at)}</small>{message.status === "blocked" && <small>Mensagem moderada pelo Mercado Livre</small>}{message.raw_data?.attachments?.length > 0 && <small>{message.raw_data.attachments.length} anexo(s) recebido(s) · metadados preservados</small>}</div>)}
    </div>{isClaim ? <ClaimControls id={id} data={data} mode="chat" onChange={changeDetail}/> : <p className={styles.readOnly}>Somente leitura · envio ainda não habilitado</p>}{error && <p role="alert" className="form-error">{error}</p>}</section>
    <div className={styles.rightColumn}><section className={styles.detailCard}><h2>Gerais</h2><button type="button" className="secondary" onClick={() => setRetry(n => n + 1)}>Atualizar dados locais</button><dl className={styles.generalFields}>
      {displayFields([
        ["ID do Caso", row.external_case_id], ["Venda/pedido", row.order_id || row.sale?.order_id],
        ["Motivo", caseReason(row)], ["Descrição do comprador", row.buyer_description],
        ["Solução/resolução", humanLabel(typeof row.resolution === "string" ? row.resolution : resolution.reason)],
        ["Data da resolução", resolution.date_created ? caseDate(resolution.date_created) : null],
        ...returnFields(row),
        ["Modalidade de envio", row.reverse_logistics?.modality], ["Transportadora", row.reverse_logistics?.carrier], ["Ponto/agência", row.reverse_logistics?.point],
        ["Prazo vendedor", isClaim && sellerDeadline(row,data.deadlines) ? caseDate(sellerDeadline(row,data.deadlines)) : null],
        ["Prazos oficiais conhecidos", !isClaim && data.deadlines.length ? data.deadlines.map(deadlineLabel).join("; ") : null]
      ]).map(([label,value]) => <Field key={label} label={label} value={value}/>)}
    </dl>{row.marketplace !== "shopee" && data.evidence?.length > 0 && <div><h3>Evidências persistidas</h3><ul>{data.evidence.map((evidence: Row) => <li key={evidence.id}>{evidence.media_type}: {evidence.reference}</li>)}</ul></div>}<div className={styles.detailProducts}>{data.items.map((item: Row, i: number) => <div className={styles.product} key={item.id || i}><Photo product={item.product}/><div>{item.product?.title}{item.sku && <div>SKU: {item.sku}</div>}{item.quantidade != null && <div>Quantidade: {item.quantidade}</div>}{item.valor_total != null && <div>Valor: {caseMoney(item.valor_total)}</div>}</div></div>)}</div></section>
      {buyerDisplay.length > 0 && <section className={styles.detailCard}><h2>Dados do comprador</h2><dl className={styles.generalFields}>{buyerDisplay.map(([label,value]) => <Field key={label} label={label} value={value}/>)}</dl>{row.marketplace === "mercado_livre" && buyer.id && buyer.site_id && <a href={"/central-reclamacoes?marketplace=mercado_livre&account="+row.marketplace_account_id+"&buyer="+encodeURIComponent(buyer.id)+"&site="+encodeURIComponent(buyer.site_id)}>Ver casos deste comprador nesta conta</a>}</section>}
      <CaseTimeline row={row} events={data.timeline} deadlines={data.deadlines}/>
    </div>

    <section className={styles.detailCard} data-panel="previous-history"><h2>Históricos anteriores relacionados ao Pedido</h2><a href={"/chats-perguntas?" + new URLSearchParams({ tab: "all", marketplace: row.marketplace, store: row.marketplace_account_id, ...(row.order_id || row.sale?.order_id || row.buyer_name ? { search: row.order_id || row.sale?.order_id || row.buyer_name } : {}) })}>Consultar histórico em Chats e Perguntas</a></section>
    <section className={styles.detailCard} data-panel="actions"><h2>Ações</h2>{isClaim ? <ClaimControls id={id} data={data} mode="actions" onChange={changeDetail}/> : row.marketplace === "shopee" ? <ShopeeActions row={row} deadlines={data.deadlines}/> : data.actions?.length ? <><p className="muted">Registro histórico · execução ainda não habilitada nesta etapa.</p><ul>{data.actions.map((action: Row) => <li key={action.id}>{humanLabel(action.action_code) || "Ação registrada pelo marketplace"} · observado em {caseDate(action.observed_at)} · {action.mandatory === true ? "Obrigatória (oficial)" : action.mandatory === false ? "Opcional (oficial)" : "Obrigatoriedade não informada"}</li>)}</ul></> : <p className="muted">Nenhuma ação oficial disponível no momento.</p>}</section>
  </div>;
}
