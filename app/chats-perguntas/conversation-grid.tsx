"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryConversationReply, sendConversationReply, updateConversationsNow } from "./actions";

type Row = Record<string, any> & { messages: Array<Record<string, any>>; slaHours: number; slaBreached: boolean };

export function ConversationGrid({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [liveRows, setLiveRows] = useState(rows);
  const [open, setOpen] = useState(() => new Set(rows.filter(row => row.requires_response).map(row => row.id)));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(() => new Set<string>());
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });

  useEffect(() => setLiveRows(rows), [rows]);
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [router]);

  return <>
    <div className="conversation-toolbar"><span className="muted">{liveRows.length} atendimento(s) nesta página · atualização automática</span><div className="row-actions"><button className="secondary" type="button" onClick={() => setOpen(new Set(liveRows.map(row => row.id)))}>Expandir tudo</button><button className="secondary" type="button" onClick={() => setOpen(new Set())}>Recolher tudo</button><button className="secondary" disabled={pending} onClick={() => startTransition(async () => { await updateConversationsNow(); router.refresh(); })}>{pending ? "Atualizando..." : "Atualizar agora"}</button></div></div>
    <div className="conversation-list">{liveRows.map(row => {
      const isOpen = open.has(row.id);
      const draft = drafts[row.id] ?? row.messages.find(message => message.status === "error" && message.direction === "outgoing")?.text ?? "";
      const validation = validate(draft);
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
            <textarea maxLength={2000} value={draft} onChange={event => setDrafts(current => ({ ...current, [row.id]: event.target.value }))} placeholder="Digite sua resposta" rows={4}/>
            {row.marketplace === "shopee" && <div className="emoji-shortcuts" aria-label="Emojis rápidos">{["😀","😊","👍","🙏","✅","📦","🚚","❤️"].map(emoji => <button key={emoji} type="button" title={`Inserir ${emoji}`} onClick={() => setDrafts(current => ({ ...current, [row.id]: `${current[row.id] ?? draft}${emoji}` }))}>{emoji}</button>)}</div>}
            <div className="reply-meta"><span className={draft.length >= 1800 ? "character-warning" : "muted"}>{draft.length}/2.000 caracteres</span>{validation && <span className="validation-warning">{validation}</span>}</div>
            {notices[row.id] && <div className={notices[row.id].startsWith("Erro") ? "form-error" : "form-success"}>{notices[row.id]}</div>}
            <div className="form-actions">
              {row.last_error && <button className="secondary" disabled={sending.has(row.id)} onClick={async () => { const fd = new FormData(); fd.set("conversationId", row.id); const result = await retryConversationReply(fd); setNotices(current => ({ ...current, [row.id]: result.ok ? "Nova tentativa iniciada." : `Erro: ${result.error}` })); router.refresh(); }}>Tentar novamente</button>}
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
      router.refresh();
    } else {
      setNotices(current => ({ ...current, [row.id]: `Erro: ${result.error}` }));
      setDrafts(current => ({ ...current, [row.id]: text }));
      setLiveRows(current => current.map(item => item.id === row.id ? { ...item, messages: item.messages.map(message => message.id === optimisticId ? { ...message, status: "error" } : message) } : item));
    }
  }
}

function sortByLatest(a: Row, b: Row) { return new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime(); }

function Timeline({ row }: { row: Row }) {
  const purchase = row.purchased_at ? new Date(row.purchased_at).getTime() : null;
  const before = purchase ? row.messages.filter(message => new Date(message.sent_at).getTime() < purchase) : row.messages;
  const after = purchase ? row.messages.filter(message => new Date(message.sent_at).getTime() >= purchase) : [];
  return <div className="conversation-timeline"><Divider label="Pré-venda"/>{before.map(message => <Message key={message.id} message={message} row={row}/>)}{purchase && <><div className="purchase-marker">Compra realizada{row.order_id ? ` — Pedido ${row.order_id}` : ""} — {formatDate(row.purchased_at)}</div><Divider label="Pós-venda"/>{after.map(message => <Message key={message.id} message={message} row={row}/>)}</>}</div>;
}
function Divider({ label }: { label: string }) { return <div className="timeline-divider"><span>{label}</span></div>; }
function Message({ message, row }: { message: Record<string, any>; row: Row }) {
  const type = String(message.message_type || message.raw_data?.message_type || "text").toLowerCase();
  const imageUrl = messageImageUrl(message.raw_data);
  const isItem = type === "item" || Boolean(message.raw_data?.content?.item_id);
  return <div className={`chat-message ${message.direction}`}>
    {isItem ? <div className="chat-product-card">{row.product_image_url && <img src={row.product_image_url} alt=""/>}<div><small>Produto</small><strong>{row.product_title || `Produto ${message.raw_data?.content?.item_id || ""}`}</strong>{row.product_price != null && <span>{Number(row.product_price).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>}</div></div> : imageUrl ? <a href={imageUrl} target="_blank" rel="noreferrer"><img className="chat-attachment" src={imageUrl} alt="Imagem enviada no chat"/></a> : <div>{message.text || `[${type || "mensagem"}]`}</div>}
    <small>{message.sender_name || (message.direction === "incoming" ? "Cliente" : "Loja")} · {formatDate(message.sent_at)}{message.direction === "outgoing" && <span className={`message-tick ${message.status === "sent" ? "confirmed" : message.status === "error" ? "failed" : ""}`} title={message.status === "sent" ? "Confirmada pela fila" : message.status === "error" ? "Falha no envio" : "Aguardando confirmação"}>✓</span>}</small>
  </div>;
}
function messageImageUrl(raw: Record<string, any> | null | undefined) { const value = raw?.content?.image_url || raw?.content?.url || raw?.image_url || raw?.url || raw?.content?.image?.url; return typeof value === "string" ? value : ""; }
function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); if (minutes < 60) return `Há ${minutes} minuto${minutes === 1 ? "" : "s"}`; const hours = Math.floor(minutes / 60), rest = minutes % 60; return rest ? `Há ${hours}h e ${rest} min` : `Há ${hours}h`; }
function formatDate(value: string) { return value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"; }
function mask(value: string) { return value.length <= 4 ? value : `${value.slice(0, 2)}•••${value.slice(-2)}`; }
function statusLabel(value: string) { return ({ answered: "Respondida", closed: "Encerrada", review: "Em revisão", blocked: "Bloqueada", error: "Erro", pending: "Pendente" } as Record<string, string>)[value] || value; }
function validate(text: string) { if (!text) return ""; if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(text)) return "E-mails não são permitidos."; if (/(?:https?:\/\/|www\.|\b(?:bit\.ly|tinyurl\.com|wa\.me)\b)/i.test(text)) return "Links externos não são permitidos."; if (/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-.\s]?\d{4}/.test(text) || /whats(?:app)?/i.test(text)) return "Telefone ou WhatsApp não são permitidos."; if (/\b(?:pix|chave\s+pix|instagram|facebook|telegram)\b/i.test(text)) return "Contato ou pagamento externo não é permitido."; return ""; }
function conversationUrl(row: Row) { if (row.raw_data?.marketplace_url) return String(row.raw_data.marketplace_url); if (row.marketplace === "mercado_livre") return row.raw_data?.item_permalink || "https://www.mercadolivre.com.br/perguntas"; if (row.marketplace === "shopee") return "https://seller.shopee.com.br/webchat"; return null; }
function productListingUrl(row: Row) { const explicitUrl = row.raw_data?.item_permalink || row.raw_data?.permalink || row.raw_data?.product_url; if (explicitUrl) return String(explicitUrl); if (!row.listing_id) return null; if (row.marketplace === "mercado_livre") { const digits = String(row.listing_id).replace(/^MLB/i, ""); return `https://produto.mercadolivre.com.br/MLB-${digits}-_JM`; } if (row.marketplace === "shopee") { const shopId = row.config_marketplace_accounts?.shop_id; return shopId ? `https://shopee.com.br/product/${encodeURIComponent(shopId)}/${encodeURIComponent(row.listing_id)}` : `https://shopee.com.br/search?keyword=${encodeURIComponent(row.listing_id)}`; } return null; }
function originalStatus(row: Row) { if (row.raw_data?.deleted_from_listing) return `${row.external_status || "UNANSWERED"} · Removida do anúncio`; if (row.external_status === "NOT_INFORMED") return "Não informado pelo marketplace"; return row.external_status || "Não informado pelo marketplace"; }
