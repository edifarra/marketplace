"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ConversationCursor, mergeConversationDelta, shouldPollConversationChanges } from "@/lib/marketplace-conversation-delta";
import { ConversationRow, ConversationView, conversationTimelineSections } from "@/lib/marketplace-conversation-view";
import { mercadoLivreAttachments, shopeeMessageImageUrl, shopeeOutOfStockReminderContent } from "@/lib/marketplace-special-messages";
import { messagesWithVisibleShopeeProductCards } from "@/lib/shopee-message-product-cards";
import { validateMarketplaceReply } from "@/lib/marketplace-reply-validation";
import { latestShopeeMessageId } from "@/lib/shopee-chat-management-state";
import { manageShopeeConversation, retryConversationReply, sendConversationReply, updateConversationsNow } from "./actions";

import { conversationProductLinks } from "./product-links";

type Row = ConversationRow;
type DeltaResponse = { cursor: ConversationCursor; changes: Row[]; changedConversationIds: string[]; hasMore: boolean };

export function ConversationGrid({ rows, initialCursor, view, pageSize }: { rows: Row[]; initialCursor: ConversationCursor; view: ConversationView; pageSize: number }) {
  const router = useRouter();
  const initialCursorId = initialCursor.id;
  const initialCursorUpdatedAt = initialCursor.updatedAt;
  const [liveRows, setLiveRows] = useState(rows);
  const [open, setOpen] = useState(() => new Set(rows.filter(row => row.requires_response).map(row => row.id)));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(() => new Set<string>());
  const [chatActions, setChatActions] = useState<Record<string, string>>({});
  const chatActionIds = useRef<Record<string, string>>({});
  const [chatActionNotices, setChatActionNotices] = useState<Record<string, string>>({});
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
      const actionIds = Object.values(chatActionIds.current).filter(id => id !== "submitting");
      if (actionIds.length) {
        const statusResponse = await fetch('/api/chats/action-status?' + new URLSearchParams({ ids: actionIds.join(',') }), { cache: "no-store" });
        if (!statusResponse.ok) throw new Error("Não foi possível consultar as ações de chat.");
        const status = await statusResponse.json() as { activities: Array<{ id: string; source_id: string; activity_type: string; status: string; processing_error?: string }> };
        for (const item of status.activities) {
          if (item.status !== "completed" && item.status !== "error") continue;
          if (chatActionIds.current[item.source_id] !== item.id) continue;
          if (item.status === "completed") router.refresh();
          delete chatActionIds.current[item.source_id];
          setChatActions(current => { const next = { ...current }; delete next[item.source_id]; return next; });
          if (item.activity_type === "conversation_delete" && item.status === "completed") setSyncNotice("Exclusão do chat confirmada pela Shopee.");
          setChatActionNotices(current => ({ ...current, [item.source_id]: item.status === "error"
            ? 'Erro: ' + (item.processing_error || 'a Shopee não confirmou a ação.')
            : item.activity_type === "conversation_read" ? "Leitura confirmada pela Shopee. A pendência de resposta permanece quando aplicável." : "Exclusão confirmada pela Shopee." }));
          // Fetch the canonical row on the following delta; do not infer its state
          // from completion (a new incoming message may have arrived meanwhile).
        }
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
  }, [pageSize, view, router]);

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
      const validation = draft ? validateMarketplaceReply(draft, {
        marketplace: row.marketplace,
        conversation_type: row.conversation_type
      }).blocked[0] || "" : "";
      const maximumLength = row.marketplace === "mercado_livre" && row.conversation_type === "post_sale" ? 350 : 2000;
      const canReply = row.marketplace === "shopee" || row.requires_response && !["closed", "review", "blocked"].includes(row.status);
      const { productId, listingUrl } = conversationProductLinks(row);
      const lastMessageId = row.shopee_last_message_id || latestShopeeMessageId(row.messages);
      return <article key={row.id} className={`conversation-card ${row.requires_response ? "pending" : ""}`}>
        <div className="conversation-header">
        <button type="button" className="conversation-summary" onClick={() => toggle(row.id)} aria-expanded={isOpen}>
          <span className={`pending-dot ${row.requires_response ? "visible" : ""}`} aria-label={row.requires_response ? row.unread ? "Não lida, resposta pendente" : "Lida, resposta pendente" : "Sem pendência"}/>
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
        {row.marketplace === "shopee" && <details className="conversation-options">
          <summary aria-label={`Opções do chat de ${row.buyer_name || row.external_conversation_id}`} title="Opções do chat">⋯</summary>
          <div className="conversation-options-panel">
            <button type="button" className="secondary" disabled={Boolean(chatActions[row.id]) || !lastMessageId} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void manageChat(row, "conversation_read", lastMessageId); }}>Marcar como lido</button>
            <button type="button" className="secondary" disabled={Boolean(chatActions[row.id]) || !lastMessageId} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); if (confirm("Excluir esta conversa na Shopee? O histórico interno será preservado. Novas mensagens podem trazer o chat de volta.")) void manageChat(row, "conversation_delete", lastMessageId); }}>Excluir chat</button>
            <small>As ações serão processadas na Shopee. Marcar como lido não dispensa responder.</small>
            {!lastMessageId && <small>Atualize o chat para obter a última mensagem.</small>}
          </div>
        </details>}
        </div>
        {chatActionNotices[row.id] && <div className={chatActionNotices[row.id].startsWith("Erro") ? "form-error" : "form-success"} role="status">{chatActionNotices[row.id]} <a href="/atividades-marketplace/enviadas">Ver fila</a></div>}
        {isOpen && <div className="conversation-detail">
          <div className="conversation-person"><div><strong>{row.buyer_name || (row.buyer_id ? `Cliente ${mask(row.buyer_id)}` : "Cliente não identificado")}</strong><small className="conversation-source">Fonte: API oficial{row.marketplace === "shopee" && <> · {row.unread ? "Não lida" : "Lida"}</>} · {row.question_count > 1 ? `IDs ${row.grouped_external_ids.join(", ")}` : `ID ${row.external_conversation_id}`} · Estado original: {originalStatus(row)}</small></div><div className="conversation-context-actions"><span>{row.order_id ? `Pedido ${row.order_id}` : row.conversation_type === "question" ? `${row.question_count || 1} pergunta${row.question_count === 1 ? "" : "s"} neste produto` : "Conversa com a loja"}{conversationUrl(row) ? <> · <a href={conversationUrl(row)!} target="_blank" rel="noreferrer">Abrir no marketplace</a></> : null}</span><div className="conversation-product-links">{listingUrl && <a className="secondary link-button compact" href={listingUrl} target="_blank" rel="noopener noreferrer">Ver Anuncio</a>}{productId && <a className="secondary link-button compact" href={`/produtos/${encodeURIComponent(productId)}`}>Ver produto</a>}</div></div></div>
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

  async function manageChat(row: Row, action: string, lastMessageId: string) {
    if (chatActionIds.current[row.id]) return;
    chatActionIds.current[row.id] = "submitting";
    setChatActions(current => ({ ...current, [row.id]: action }));
    const fd = new FormData(); fd.set("conversationId", row.id); fd.set("action", action); fd.set("lastMessageId", lastMessageId);
    try {
      const result = await manageShopeeConversation(fd);
      if (!result.ok) throw new Error(result.error);
      chatActionIds.current[row.id] = result.activityId;
      setChatActionNotices(current => ({ ...current, [row.id]: "Ação enviada para a fila. Aguardando confirmação da Shopee..." }));
    } catch (error) {
      delete chatActionIds.current[row.id];
      setChatActions(current => { const next = { ...current }; delete next[row.id]; return next; });
      setChatActionNotices(current => ({ ...current, [row.id]: 'Erro: ' + (error instanceof Error ? error.message : String(error)) }));
    }
  }

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
  const messagesWithProductCard = messagesWithVisibleShopeeProductCards(row.messages);
  return <div className="conversation-timeline">{!postSaleOnly && <Divider label="Pré-venda"/>}{before.map((message: Record<string, any>) => <Message key={message.id} message={message} row={row} showItemCard={messagesWithProductCard.has(message)}/>)}{purchase && <div className="purchase-marker">Compra realizada{row.order_id ? ` — Pedido ${row.order_id}` : ""} — {formatDate(row.purchased_at)}</div>}{(postSaleOnly || purchase) && <Divider label="Pós-venda"/>}{after.map((message: Record<string, any>) => <Message key={message.id} message={message} row={row} showItemCard={messagesWithProductCard.has(message)}/>)}</div>;
}
function Divider({ label }: { label: string }) { return <div className="timeline-divider"><span>{label}</span></div>; }
export function Message({ message, row, showItemCard }: { message: Record<string, any>; row: Row; showItemCard: boolean }) {
  const type = String(message.message_type || message.raw_data?.message_type || "text").toLowerCase();
  const imageUrl = shopeeMessageImageUrl(message.raw_data);
  const reminder = shopeeOutOfStockReminderContent(message.raw_data);
  const attachments = mercadoLivreAttachments(message.raw_data);
  const itemCard = message.shopee_item_card;
  const isOrder = type === "order";
  const ordinaryContent = attachments.length ? <div>{attachments.map((attachment, index) => {
    const url = `/api/chats/attachments/${encodeURIComponent(message.id)}?index=${index}`;
    return attachment.isImage
      ? <a key={`${attachment.id}:${index}`} href={url} target="_blank" rel="noreferrer"><img className="chat-attachment" src={url} loading="lazy" alt={attachment.name || "Imagem enviada no chat"}/></a>
      : <a key={`${attachment.id}:${index}`} className="secondary link-button compact" href={url} target="_blank" rel="noreferrer">Baixar {attachment.name || "anexo"}</a>;
  })}{message.text && <div>{message.text}</div>}</div>
    : isOrder ? <div className="chat-product-card">{row.product_image_url && <img src={row.product_image_url} alt=""/>}<div><small>Pedido {row.order_id || message.raw_data?.content?.order_sn || message.raw_data?.source_content?.order_sn || ""}</small><strong>{row.product_title || "Pedido compartilhado pelo cliente"}</strong>{row.sku && <span>SKU {row.sku}</span>}{row.product_price != null && <span>{Number(row.product_price).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>}</div></div>
    : imageUrl ? <div><a href={imageUrl} target="_blank" rel="noreferrer"><img className="chat-attachment" src={imageUrl} loading="lazy" alt="Imagem enviada no chat"/></a>{message.text && <div className="chat-image-text">{message.text}</div>}</div>
    : message.text ? <div>{message.text}</div> : !itemCard ? <div>{`[${type || "mensagem"}]`}</div> : null;
  const bubble = <div className={`chat-message ${reminder ? "system shopee-reminder" : message.direction}`}>
    {reminder ? <div><strong>{reminder.title}</strong><p>{reminder.description}</p>{reminder.productName && <span>{reminder.productName}</span>}{reminder.itemId && <small>Item {reminder.itemId}{reminder.stock != null ? ` · Estoque informado: ${reminder.stock}` : ""}</small>}</div>
      : ordinaryContent}
    <small>{reminder ? "Shopee" : message.sender_name || (message.direction === "incoming" ? "Cliente" : "Loja")} · {formatDate(message.sent_at)}{message.direction === "outgoing" && <span className={`message-tick ${message.status === "sent" ? "confirmed" : message.status === "error" ? "failed" : ""}`} title={message.status === "sent" ? "Confirmada pela fila" : message.status === "error" ? "Falha no envio" : "Aguardando confirmação"}>✓</span>}</small>
  </div>;
  if (!showItemCard || !itemCard) return bubble;
  return <div className="chat-message-group incoming">
    <div className="chat-product-card message-item-card">{itemCard.image_url && <img src={itemCard.image_url} alt=""/>}<div><small>O cliente está perguntando sobre este anúncio/produto</small><strong>{itemCard.title || `Anúncio ${itemCard.item_id}`}</strong>{itemCard.sku && <span>SKU {itemCard.sku}</span>}{itemCard.price != null && <span>{Number(itemCard.price).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>}{!itemCard.found && <span>Anúncio não localizado no catálogo local</span>}</div></div>
    {bubble}
  </div>;
}
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); if (minutes < 60) return `Há ${minutes} minuto${minutes === 1 ? "" : "s"}`; const hours = Math.floor(minutes / 60), rest = minutes % 60; return rest ? `Há ${hours}h e ${rest} min` : `Há ${hours}h`; }
function formatDate(value: string) { return value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"; }
function mask(value: string) { return value.length <= 4 ? value : `${value.slice(0, 2)}•••${value.slice(-2)}`; }
function statusLabel(value: string) { return ({ answered: "Respondida", closed: "Encerrada", review: "Em revisão", blocked: "Bloqueada", error: "Erro", pending: "Pendente" } as Record<string, string>)[value] || value; }
function conversationUrl(row: Row) { if (row.raw_data?.marketplace_url) return String(row.raw_data.marketplace_url); if (row.marketplace === "mercado_livre") return row.raw_data?.item_permalink || "https://www.mercadolivre.com.br/perguntas"; if (row.marketplace === "shopee") return "https://seller.shopee.com.br/webchat"; return null; }
function originalStatus(row: Row) { if (row.raw_data?.deleted_from_listing) return `${row.external_status || "UNANSWERED"} · Removida do anúncio`; if (row.external_status === "NOT_INFORMED") return "Não informado pelo marketplace"; return row.external_status || "Não informado pelo marketplace"; }
