"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { caseDate, caseImage, caseMoney, caseReason, sellerDeadline, caseStatusLabel, deadlineLabel, reputationLabel } from "./case-display";
import { caseAttention, caseContext } from "@/lib/marketplace-case-context";
import { ClaimControls } from "./claim-controls";
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
      <span className={styles.marketplace}><Image unoptimized width={46} height={46} src={row.marketplace === "shopee" ? "/marketplaces/shopee-mini.webp" : "/marketplaces/mercado-livre-mini.png"} alt=""/><span><strong>{row.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}</strong><span className="muted">Loja {row.account?.name || row.account?.nickname || "Não informado"}</span><small className="muted">Caso #{row.external_case_id}</small></span></span>
      <span className={styles.sale}>{(row.items.length ? row.items : [{}]).map((item: Row, index: number) => <span className={styles.product} key={item.id || index}><Photo product={item.product}/><span><strong>Venda #{row.order_id || row.sale?.order_id || "Não informado"}</strong><span>{item.product?.title || "Produto não informado"}</span><small className="muted">SKU {item.sku || "—"} · Qtd. {item.quantidade ?? "—"} · {caseMoney(item.valor_total)}</small></span></span>)}</span>
      <span className={styles.caseBlock}>{caseContext(row) === "return" && <><span>Nome logístico: {row.reverse_logistics?.contact_name || "Não informado"}</span><span>Código de retorno: {row.reverse_logistics?.tracking || "Não informado"}</span></>}<span>Motivo: {caseReason(row) || "Não informado"}</span>{reputationLabel(row) && <span className={row.marketplace !== "shopee" && row.reputation_impact === "affected" ? styles.affected : row.marketplace !== "shopee" && row.reputation_impact === "not_affected" ? styles.positive : "muted"}>{reputationLabel(row)}</span>}</span>
      <span className={styles.situation}><span>{caseStatusLabel(row)}</span>{row.marketplace === "mercado_livre" ? sellerDeadline(row,row.deadlines) && <span>Prazo: <strong className={styles.deadline}>{caseDate(sellerDeadline(row,row.deadlines))}</strong></span> : <span>Prazo: {row.deadlines.length ? row.deadlines.map(deadlineLabel).join("; ") : "Não informado"}</span>}<span>Precisa de ação: {caseAttention(row) === "ACTION_REQUIRED" ? "Sim" : "Não"}</span><span>Última atualização local: {caseDate(row.updated_at)}</span><span className={`${styles.badge} ${styles[row.group]}`}>{row.groupLabel}</span></span>
      <span className={`${styles.chevron} ${expanded === row.id ? styles.rotated : ""}`} aria-hidden="true">⌄</span>
    </button>
    {expanded === row.id && <div id={`detail-${row.id}`} className={styles.expansion}><CaseDetail id={row.id}/></div>}
  </article>)}</div>;
}
function Field({ label, value }: { label: string; value: any }) {
  return <div><dt>{label}</dt><dd className={label === "Prazo vendedor" ? styles.sellerDeadline : undefined}>{value == null || value === "" ? "Não informado" : String(value)}</dd></div>;
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
  const isClaim = row.marketplace === "mercado_livre" && row.case_type === "claim";
  const buyer = row.buyer_data || {};
  const logistics = row.reverse_logistics || {};
  const resolution = row.resolution || {};
  return <div className={styles.drilldown}>
    <section className={styles.chatPanel}><h2>Chat</h2>{isClaim && <div className={styles.claimContext}><strong>{row.status === "closed" ? "Reclamação encerrada" : "Reclamação aberta"} nº {row.external_case_id}{row.reputation_impact === "not_affected" ? " · Não afetou sua reputação" : row.reputation_impact === "affected" ? " · Afeta sua reputação" : ""}</strong>{caseReason(row) && <p>Motivo: {caseReason(row)}</p>}{row.reason && <p>Descrição: {row.reason}</p>}</div>}<div className={styles.chatScroll} ref={chat} role="log" aria-label="Histórico local da conversa">
      {data.olderMessages && <button type="button" className="secondary" onClick={older} disabled={olderLoading}>{olderLoading ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {!data.conversation ? <p className="muted">Nenhuma conversa vinculada a este Caso.</p> : !data.messages.length ? <p className="muted">A conversa vinculada não tem mensagens locais disponíveis.</p> : data.messages.map((message: Row) => <div key={message.id} className={`chat-message ${["incoming", "outgoing"].includes(message.direction) ? message.direction : "system"}`}><strong>{message.sender_name || (message.direction === "outgoing" ? "Vendedor" : message.direction === "incoming" ? "Comprador" : "Sistema")}</strong><div className={styles.messageText}>{message.text || `${message.message_type || "Conteúdo"} — conteúdo textual não informado`}</div><small>{caseDate(message.sent_at || message.created_at)}</small>{message.status === "blocked" && <small>Mensagem moderada pelo Mercado Livre</small>}{message.raw_data?.attachments?.length > 0 && <small>{message.raw_data.attachments.length} anexo(s) recebido(s) · metadados preservados</small>}</div>)}
    </div>{isClaim ? <ClaimControls id={id} data={data} mode="chat" onChange={setData}/> : <p className={styles.readOnly}>Somente leitura · envio ainda não habilitado</p>}{error && <p role="alert" className="form-error">{error}</p>}</section>
    <div className={styles.rightColumn}><section className={styles.detailCard}><h2>Gerais</h2><dl className={styles.generalFields}>
      {isClaim ? <>{[["ID Caso",row.external_case_id],["Venda/Pedido",row.order_id],["Motivo",caseReason(row)],["Solução/Resolução",resolution.reason],["Data resolução",resolution.date_created ? caseDate(resolution.date_created) : null],["ID devolução",logistics.return_id],["Nome logístico devolução",logistics.contact_name],["Logística reversa",logistics.status],["Código retorno",logistics.tracking],["Prazo vendedor",sellerDeadline(row,data.deadlines) ? caseDate(sellerDeadline(row,data.deadlines)) : null]].filter(([,value])=>value != null && value !== "").map(([label,value])=><Field key={label} label={String(label)} value={value}/>)}</> : <>      <Field label="Marketplace" value={row.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}/><Field label="Conta" value={row.account?.name || row.account?.nickname}/><Field label="ID do Caso" value={row.external_case_id}/><Field label="Venda/pedido" value={row.order_id || row.sale?.order_id}/><Field label="Comprador" value={row.buyer_name || data.conversation?.buyer_name || data.conversation?.buyer_id}/>
      <Field label="Motivo" value={row.reason || row.reason_code}/><Field label="Descrição do comprador" value={row.buyer_description}/><Field label="Reputação oficial" value={reputationLabel(row)}/>
      <Field label="Solução/resolução" value={typeof row.resolution === "string" ? row.resolution : resolution.reason}/><Field label="Encerrado por" value={resolution.closed_by}/><Field label="Data da resolução" value={resolution.date_created ? caseDate(resolution.date_created) : null}/>
      <Field label="Contexto" value={caseContext(row) === "return" ? "Devolução" : "Reclamação"}/><Field label="ID da devolução" value={logistics.return_id || (row.case_type === "return" ? row.external_case_id : null)}/><Field label="Reclamação original" value={row.related_claim_id || (row.case_type === "claim" ? row.external_case_id : null)}/><Field label="Nome logístico da devolução" value={logistics.contact_name}/><Field label="Tipo de validação" value={row.validation_type}/><Field label="Ponto/agência" value={logistics.point}/><Field label="Evidência do vendedor" value={row.seller_proof_status}/><Field label="Negociação" value={row.negotiation_status}/><Field label="Logística reversa" value={logistics.status}/><Field label="Código de retorno" value={logistics.tracking}/><Field label="Transportadora" value={logistics.carrier}/><Field label="Modalidade" value={logistics.modality}/><Field label="Prazos oficiais conhecidos" value={data.deadlines.length ? data.deadlines.map(deadlineLabel).join("; ") : null}/>
</>}
    </dl>{data.evidence?.length > 0 && <div><h3>Evidências persistidas</h3><ul>{data.evidence.map((evidence: Row) => <li key={evidence.id}>{evidence.media_type}: {evidence.reference}</li>)}</ul></div>}<div className={styles.detailProducts}>{(data.items.length ? data.items : [{}]).map((item: Row, i: number) => <div className={styles.product} key={item.id || i}><Photo product={item.product}/><div>{item.product?.title || "Produto: Não informado"}<div>SKU: {item.sku || "Não informado"}</div><div>Quantidade: {item.quantidade ?? "Não informado"} · Valor: {caseMoney(item.valor_total)}</div></div></div>)}</div></section>
      {isClaim && Object.keys(buyer).length > 0 && <section className={styles.detailCard}><h2>Dados do comprador</h2><dl className={styles.generalFields}>{[["Nome comercial",buyer.display_name],["Nome público",buyer.nickname],["Razão social",buyer.legal_name],[buyer.document_type || "Documento",buyer.document_number],["Endereço fiscal",buyer.fiscal_address ? [buyer.fiscal_address.street_name,buyer.fiscal_address.street_number,buyer.fiscal_address.neighborhood,buyer.fiscal_address.city_name,buyer.fiscal_address.state?.name].filter(Boolean).join(" · ") : null],["CEP",buyer.fiscal_address?.zip_code],["Tipo cliente",buyer.customer_type === "BU" ? "Pessoa jurídica" : buyer.customer_type === "CO" ? "Pessoa física" : null],["Situação fiscal",buyer.taxpayer_type]].filter(([,value])=>value != null && value !== "").map(([label,value])=><Field key={label} label={String(label)} value={value}/>)}</dl>{buyer.id && buyer.site_id && <a href={"/central-reclamacoes?marketplace=mercado_livre&account="+row.marketplace_account_id+"&buyer="+encodeURIComponent(buyer.id)+"&site="+encodeURIComponent(buyer.site_id)}>Ver casos deste comprador nesta conta</a>}</section>}
      <section className={styles.detailCard}><h2>Timeline</h2>{!data.timeline.length ? <><p className="muted">Ainda não há eventos estruturados para este Caso.</p><p className="muted">Eventos futuros aparecerão aqui conforme forem persistidos.</p></> : <div className="shipping-timeline">{data.timeline.map((event: Row) => <div key={event.id} className="shipping-event"><time>{caseDate(event.official_at || event.observed_at)}</time><div><strong>{event.event_type}</strong>{Object.entries(isClaim ? {} : event.state || {}).filter(([, value]) => value != null && value !== "unknown").map(([key, value]) => <span key={key}>{key}: {typeof value === "object" ? JSON.stringify(value) : String(value)}</span>)}</div></div>)}</div>}</section>
      <section className={styles.detailCard}><h2>Ações</h2>{isClaim ? <ClaimControls id={id} data={data} mode="actions" onChange={setData}/> : !data.actions.length ? <p className="muted">Nenhuma ação oficial disponível no momento.</p> : <><p className="muted">Registro histórico · execução ainda não habilitada nesta etapa.</p><ul>{data.actions.map((action: Row) => <li key={action.id}>{action.action_code} · observado em {caseDate(action.observed_at)} · {action.mandatory === true ? "Obrigatória (oficial)" : action.mandatory === false ? "Opcional (oficial)" : "Obrigatoriedade não informada"}</li>)}</ul></>}</section>
    </div>
  </div>;
}
