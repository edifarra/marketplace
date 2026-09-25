"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ConversationCursor, mergeConversationDelta, shouldPollConversationChanges } from "@/lib/marketplace-conversation-delta";
import { ConversationRow, ConversationView, conversationTimelineSections } from "@/lib/marketplace-conversation-view";
import { mercadoLivreAttachments, shopeeMessageImageUrl, shopeeOutOfStockReminderContent } from "@/lib/marketplace-special-messages";
import { retryConversationReply, sendConversationReply, updateConversationsNow } from "./actions";

type Row = ConversationRow;
type DeltaResponse = { cursor: ConversationCursor; changes: Row[]; changedConversationIds: string[]; hasMore: boolean };

export function ConversationGrid({ rows, initialCursor, view, pageSize }: { rows: Row[]; initialCursor: ConversationCursor; view: ConversationView; pageSize: number }) {
  const initialCursorId = initialCursor.id;
  const initialCursorUpdatedAt = initialCursor.updatedAt;
  const [liveRows, setLiveRows] = useState(rows);
  const [open, setOpen] = useState(() => new Set(rows.filter(row => row.requires_response).map(row => row.id)));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(() => new Set<string>());
  const [syncNotice, setSyncNotice] = useState("");
  const cursor = useRef(initialCursor);
  const polling = useRef(false);
  const syncActivityId = useRef<string | null>(null);
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });

  useEffect(() => {
    setLiveRows(rows);
    cursor.current = { id: initialCursorId, updatedAt: initialCursorUpdatedAt };
  }, [rows, initialCursorId, initialCursorUpdatedAt]);

  const pollChanges = useCallback(async () => {
    if (polling.current || !shouldPollConversationChanges(document.visibilityState)) return;
    polling.current = true;
    try {
      let hasMore = true;
      while (hasMore) {
        const query = new URLSearchParams({ after: cursor.current.updatedAt, afterId: cursor.current.id });
        const response = await fetch(`/api/chats/changes?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Não foi possível verificar atualizações dos chats.");
        const payload = await response.json() as DeltaResponse;
        cursor.current = payload.cursor;
        hasMore = payload.hasMore;
        setLiveRows(current => mergeConversationDelta(current, payload.changes, payload.changedConversationIds, view, pageSize));
      }
      if (syncActivityId.current) {
        const statusResponse = await fetch(`/api/chats/sync-status?id=${encodeURIComponent(syncActivityId.current)}`, { cache: "no-store" });
        if (statusResponse.ok) {
          const payload = await statusResponse.json() as { activity: { status: string; processing_error?: string | null } };
          if (payload.activity.status === "processed") {
            syncActivityId.current = null;
            setSyncNotice("Sincronização com os marketplaces concluída.");
          } else if (payload.activity.status === "error") {
            syncActivityId.current = null;
            setSyncNotice(`Erro na sincronização: ${payload.activity.processing_error || "falha não informada"}`);
          }
        }
      }
    } catch (error) {
      setSyncNotice(error instanceof Error ? error.message : String(error));
    } finally {
      polling.current = false;
    }
  }, [pageSize, view]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (shouldPollConversationChanges(document.visibilityState)) void pollChanges();
    };
    const handleVisibilityChange = () => {
      if (shouldPollConversationChanges(document.visibilityState)) void pollChanges();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [pollChanges]);

  return <>
    <div className="conversation-toolbar"><span className="muted">{liveRows.length} atendimento(s) nesta página · atualização automática</span><div className="row-actions"><button className="secondary" type="button" onClick={() => setOpen(new Set(liveRows.map(row => row.id)))}>Expandir tudo</button><button className="secondary" type="button" onClick={() => setOpen(new Set())}>Recolher tudo</button><button className="secondary" disabled={pending} onClick={() => startTransition(async () => { try { const result = await updateConversationsNow(); syncActivityId.current = result.result.id; setSyncNotice("Sincronização solicitada. Aguardando processamento pelo worker..."); await pollChanges(); } catch (error) { setSyncNotice(`Erro ao solicitar sincronização: ${error instanceof Error ? error.message : String(error)}`); } })}>{pending ? "Solicitando..." : "Atualizar agora"}</button></div></div>
    {syncNotice && <div className={syncNotice.startsWith("Erro") || syncNotice.startsWith("Não foi") ? "form-error" : "form-success"}>{syncNotice}</div>}
    <div className="conversation-list">{liveRows.map(row => {
      const isOpen = open.has(row.id);
      const draft = drafts[row.id] ?? row.messages.find(message => message.status === "error" && message.direction === "outgoing")?.text ?? "";
      const validation = validate(draft);
      const maximumLength = row.marketplace === "mercado_livre" && row.conversation_type === "post_sale" ? 350 : 2000;
      const canReply = row.marketplace === "shopee" || row.requires_response && !["closed", "review", "blocked"].includes(row.status);
      const listingUrl = productListingUrl(row);
      return <article key={row.id} className={`conversation-card ${row.requires_response ? "pending" : ""}`}>
        <button type="button" className="conversation-summary" onClick={() => toggle(row.id)} aria-expanded={isOpen}>
          <span className={`pending-dot ${row.requires_response ? "visible" : ""}`} aria-label={row.requires_response ? "Pendente" : "Respondido"}/>
          <img className="marketplace-chat-icon" src={row.marketplace === "mercado_livre" ? "/marketplaces/mercado-livre-mini.png" : "/marketplaces/shopee-mini.webp"} alt={row.marketplace === "mercado_livre" ? "Mercado Livre" : "Shopee"}/>
          <span className="conversation-store">{row.config_marketplace_accounts?.nickname || row.config_marketplace_accounts?.name || "Loja"}</span>
          <span><small>SKU</small>{row.sku || "—"}</span>
          <span className="conversation-product"><small>Produto</small>{row.product_title || "Conversa geral da loja"}</span>
          <span><small>Valor</small>{row.product_price != null ? Number(row.product_price).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—"}</span>
          <span><small>Estoque</small>{row.available_stock ?? "—"}</span>
          <span className={row.requires_response ? row.slaBreached ? "sla-breached" : "sla-ok" : "sla-neutral"}><small>Tempo sem resposta</small>{row.requires_response ? relativeTime(row.last_incoming_at || row.last_message_at) : statusLabel(row.status)}</span>
          <span><small>Recebida em</small>{formatDate(row.last_incoming_at || row.last_message_at)}</span>
          <span className="conversation-chevron">{isOpen ? "⌃" : "⌄"}</span>
        </button>
        {isOpen && <div className="conversation-detail">
          <div className="conversation-person"><div><strong>{row.buyer_name || (row.buyer_id ? `Cliente ${mask(row.buyer_id)}` : "Cliente não identificado")}</strong><small className="conversation-source">Fonte: API oficial · {row.question_count > 1 ? `IDs ${row.grouped_external_ids.join(", ")}` : `ID ${row.external_conversation_id}`} · Estado original: {originalStatus(row)}</small></div><div className="conversation-context-actions"><span>{row.order_id ? `Pedido ${row.order_id}` : row.conversation_type === "question" ? `${row.question_count || 1} pergunta${row.question_count === 1 ? "" : "s"} neste produto` : "Conversa com a loja"}{conversationUrl(row) ? <> · <a href={conversationUrl(row)!} target="_blank" rel="noreferrer">Abrir no marketplace</a></> : null}</span><div className="conversation-product-links">{listingUrl && <a className="secondary link-button compact" href={listingUrl} target="_blank" rel="noopener noreferrer">Ver Anuncio</a>}{row.product_id && <a className="secondary link-button compact" href={`/produtos/${encodeURIComponent(row.product_id)}`}>Ver produto</a>}</div></div></div>
          <Timeline row={row}/>
          {row.last_error && <div className="form-error"><strong>Falha no envio:</strong> {row.last_error}</div>}
          {canReply && <div className="reply-box">
            <textarea maxLength={maximumLength} value={draft} onChange={event => setDrafts(current => ({ ...current, [row.id]: event.target.value }))} placeholder="Digite sua resposta" rows={4}/>
            {row.marketplace === "shopee" && <div className="emoji-shortcuts" aria-label="Emojis rápidos">{["😀","😊","👍","🙏","✅","📦","🚚","❤️"].map(emoji => <button key={emoji} type="button" title={`Inserir ${emoji}`} onClick={() => setDrafts(current => ({ ...current, [row.id]: `${current[row.id] ?? draft}${emoji}` }))}>{emoji}</button>)}</div>}
            <div className="reply-meta"><span className={draft.length >= maximumLength * .9 ? "character-warning" : "muted"}>{draft.length}/{maximumLength.toLocaleString("pt-BR")} caracteres</span>{validation && <span className="validation-warning">{validation}</span>}</div>
            {notices[row.id] && <div className={notices[row.id].startsWith("Erro") ? "form-error" : "form-success"}>{notices[row.id]}</div>}
            <div className="form-actions">
              {row.last_error && <button className="secondary" disabled={sending.has(row.id)} onClick={async () => { const fd = new FormData(); fd.set("conversationId", row.id); const result = await retryConversationReply(fd); setNotices(current => ({ ...current, [row.id]: result.ok ? "Nova tentativa iniciada." : `Erro: ${result.error}` })); await pollChanges(); }}>Tentar novamente</button>}
              <button disabled={sending.has(row.id) || !draft.trim() || Boolean(validation)} onClick={() => {
                if (row.conversation_type === "question" && !confirm("A resposta pública do Mercado Livre só pode ser enviada uma vez e não poderá ser corrigida. Deseja enviar?")) return;
                void sendOptimistically(row, draft);
              }}>{sending.has(row.id) ? "Enviando..." : "Enviar resposta"}</button>
            </div>
          </div>}
          {!canReply && <div className="conversation-closed-note">{row.status === "answered" ? "Atendimento respondido." : "Este atendimento não está disponível para resposta."}</div>}
        </div>}
      </article>;
    })}{!liveRows.length && <div className="empty-state">Nenhum chat ou pergunta encontrado com os filtros selecionados.</div>}</div>
  </>;

  async function sendOptimistically(row: Row, text: string) {
    const now = new Date().toISOString();
    const optimisticId = `optimistic:${row.id}:${Date.now()}`;
    const optimisticMessage = { id: optimisticId, external_message_id: optimisticId, direction: "outgoing", message_type: "text", text: text.trim(), sender_name: "Loja", sent_at: now, status: "queued" };
    setSending(current => new Set(current).add(row.id));
    setDrafts(current => ({ ...current, [row.id]: "" }));
    setLiveRows(current => current.map(item => item.id === row.id ? { ...item, last_message_at: now, messages: [...item.messages, optimisticMessage] } : item).sort(sortByLatest));
    const fd = new FormData(); fd.set("conversationId", row.id); fd.set("text", text);
    const result = await sendConversationReply(fd);
    setSending(current => { const next = new Set(current); next.delete(row.id); return next; });
    if (result.ok) {
      setNotices(current => ({ ...current, [row.id]: "Mensagem confirmada pela fila." }));
      setLiveRows(current => current.map(item => item.id === row.id ? { ...item, messages: item.messages.map(message => message.id === optimisticId ? { ...message, status: "sent" } : message) } : item));
      await pollChanges();
    } else {
      setNotices(current => ({ ...current, [row.id]: `Erro: ${result.error}` }));
      setDrafts(current => ({ ...current, [row.id]: text }));
      setLiveRows(current => current.map(item => item.id === row.id ? { ...item, messages: item.messages.map(message => message.id === optimisticId ? { ...message, status: "error" } : message) } : item));
    }
  }
}

function sortByLatest(a: Row, b: Row) { return new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime(); }

function Timeline({ row }: { row: Row }) {
  const { before, after, purchase, postSaleOnly } = conversationTimelineSections(row);
  return <div className="conversation-timeline">{!postSaleOnly && <Divider label="Pré-venda"/>}{before.map((message: Record<string, any>) => <Message key={message.id} message={message} row={row}/>)}{purchase && <div className="purchase-marker">Compra realizada{row.order_id ? ` — Pedido ${row.order_id}` : ""} — {formatDate(row.purchased_at)}</div>}{(postSaleOnly || purchase) && <Divider label="Pós-venda"/>}{after.map((message: Record<string, any>) => <Message key={message.id} message={message} row={row}/>)}</div>;
}
function Divider({ label }: { label: string }) { return <div className="timeline-divider"><span>{label}</span></div>; }
function Message({ message, row }: { message: Record<string, any>; row: Row }) {
  const type = String(message.message_type || message.raw_data?.message_type || "text").toLowerCase();
  const imageUrl = shopeeMessageImageUrl(message.raw_data);
  const reminder = shopeeOutOfStockReminderContent(message.raw_data);
  const attachments = mercadoLivreAttachments(message.raw_data);
  const isItem = type === "item" || Boolean(message.raw_data?.content?.item_id);
  const isOrder = type === "order" || Boolean(message.raw_data?.content?.order_sn || message.raw_data?.source_content?.order_sn);
  return <div className={`chat-message ${reminder ? "system shopee-reminder" : message.direction}`}>
    {reminder ? <div><strong>{reminder.title}</strong><p>{reminder.description}</p>{reminder.productName && <span>{reminder.productName}</span>}{reminder.itemId && <small>Item {reminder.itemId}{reminder.stock != null ? ` · Estoque informado: ${reminder.stock}` : ""}</small>}</div>
      : attachments.length ? <div>{attachments.map((attachment, index) => {
      const url = `/api/chats/attachments/${encodeURIComponent(message.id)}?index=${index}`;
      return attachment.isImage
        ? <a key={`${attachment.id}:${index}`} href={url} target="_blank" rel="noreferrer"><img className="chat-attachment" src={url} loading="lazy" alt={attachment.name || "Imagem enviada no chat"}/></a>
        : <a key={`${attachment.id}:${index}`} className="secondary link-button compact" href={url} target="_blank" rel="noreferrer">Baixar {attachment.name || "anexo"}</a>;
    })}{message.text && <div>{message.text}</div>}</div>
      : isOrder ? <div className="chat-product-card">{row.product_image_url && <img src={row.product_image_url} alt=""/>}<div><small>Pedido {row.order_id || message.raw_data?.content?.order_sn || message.raw_data?.source_content?.order_sn || ""}</small><strong>{row.product_title || "Pedido compartilhado pelo cliente"}</strong>{row.sku && <span>SKU {row.sku}</span>}{row.product_price != null && <span>{Number(row.product_price).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>}</div></div>
      : isItem ? <div className="chat-product-card">{row.product_image_url && <img src={row.product_image_url} alt=""/>}<div><small>Produto</small><strong>{row.product_title || `Produto ${message.raw_data?.content?.item_id || ""}`}</strong>{row.product_price != null && <span>{Number(row.product_price).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>}</div></div>
      : imageUrl ? <div><a href={imageUrl} target="_blank" rel="noreferrer"><img className="chat-attachment" src={imageUrl} loading="lazy" alt="Imagem enviada no chat"/></a>{message.text && <div className="chat-image-text">{message.text}</div>}</div>
      : <div>{message.text || `[${type || "mensagem"}]`}</div>}
    <small>{reminder ? "Shopee" : message.sender_name || (message.direction === "incoming" ? "Cliente" : "Loja")} · {formatDate(message.sent_at)}{message.direction === "outgoing" && <span className={`message-tick ${message.status === "sent" ? "confirmed" : message.status === "error" ? "failed" : ""}`} title={message.status === "sent" ? "Confirmada pela fila" : message.status === "error" ? "Falha no envio" : "Aguardando confirmação"}>✓</span>}</small>
  </div>;
}
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); if (minutes < 60) return `Há ${minutes} minuto${minutes === 1 ? "" : "s"}`; const hours = Math.floor(minutes / 60), rest = minutes % 60; return rest ? `Há ${hours}h e ${rest} min` : `Há ${hours}h`; }
function formatDate(value: string) { return value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"; }
function mask(value: string) { return value.length <= 4 ? value : `${value.slice(0, 2)}•••${value.slice(-2)}`; }
function statusLabel(value: string) { return ({ answered: "Respondida", closed: "Encerrada", review: "Em revisão", blocked: "Bloqueada", error: "Erro", pending: "Pendente" } as Record<string, string>)[value] || value; }
function validate(text: string) { if (!text) return ""; if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(text)) return "E-mails não são permitidos."; if (/(?:https?:\/\/|www\.|\b(?:bit\.ly|tinyurl\.com|wa\.me)\b)/i.test(text)) return "Links externos não são permitidos."; if (/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-.\s]?\d{4}/.test(text) || /whats(?:app)?/i.test(text)) return "Telefone ou WhatsApp não são permitidos."; if (/\b(?:pix|chave\s+pix|instagram|facebook|telegram)\b/i.test(text)) return "Contato ou pagamento externo não é permitido."; return ""; }
function conversationUrl(row: Row) { if (row.raw_data?.marketplace_url) return String(row.raw_data.marketplace_url); if (row.marketplace === "mercado_livre") return row.raw_data?.item_permalink || "https://www.mercadolivre.com.br/perguntas"; if (row.marketplace === "shopee") return "https://seller.shopee.com.br/webchat"; return null; }
function productListingUrl(row: Row) { const explicitUrl = row.raw_data?.item_permalink || row.raw_data?.permalink || row.raw_data?.product_url; if (explicitUrl) return String(explicitUrl); if (!row.listing_id) return null; if (row.marketplace === "mercado_livre") { const digits = String(row.listing_id).replace(/^MLB/i, ""); return `https://produto.mercadolivre.com.br/MLB-${digits}-_JM`; } if (row.marketplace === "shopee") { const shopId = row.config_marketplace_accounts?.shop_id; return shopId ? `https://shopee.com.br/product/${encodeURIComponent(shopId)}/${encodeURIComponent(row.listing_id)}` : `https://shopee.com.br/search?keyword=${encodeURIComponent(row.listing_id)}`; } return null; }
function originalStatus(row: Row) { if (row.raw_data?.deleted_from_listing) return `${row.external_status || "UNANSWERED"} · Removida do anúncio`; if (row.external_status === "NOT_INFORMED") return "Não informado pelo marketplace"; return row.external_status || "Não informado pelo marketplace"; }
