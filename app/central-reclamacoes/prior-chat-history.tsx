"use client";
import Image from "next/image";
import { mercadoLivreAttachments } from "@/lib/marketplace-special-messages";
import { caseDate } from "./case-display";
import styles from "./cases.module.css";

export function PriorChatHistory({ messages }: { messages: Record<string, any>[] }) {
  if (!messages?.length) return null;
  return <section aria-label="Histórico anterior do Chat"><div className={styles.claimContext}><h3>Histórico anterior do Chat</h3><small>Contexto do atendimento · somente leitura</small></div>{messages.map(message => <div key={message.id} className={`chat-message ${message.direction}`}>
    <strong>{message.sender_name || (message.direction === "outgoing" ? "Vendedor" : "Cliente")}</strong>
    {message.text && <div className={styles.messageText}>{message.text}</div>}
    {mercadoLivreAttachments(message.raw_data).map((attachment, index) => {
      const url = `/api/chats/attachments/${encodeURIComponent(message.id)}?index=${index}`;
      return <a key={`${attachment.id}:${index}`} href={url} target="_blank" rel="noreferrer">{attachment.isImage ? <Image unoptimized src={url} width={180} height={140} style={{ objectFit: "contain" }} alt={attachment.name || "Imagem enviada no chat"}/> : `Baixar ${attachment.name || "anexo"}`}</a>;
    })}
    {!message.text && !mercadoLivreAttachments(message.raw_data).length && <div>Conteúdo sem texto · metadados preservados</div>}
    <small>{caseDate(message.sent_at)}</small>
  </div>)}<div className={styles.claimContext}><h3>Mensagens da reclamação</h3></div></section>;
}
