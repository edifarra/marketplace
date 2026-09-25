import { mercadoLivreAttachments } from "./marketplace-special-messages";

type AttachmentProxyDependencies = {
  authenticated: () => Promise<boolean>;
  loadMessage: (messageId: string) => Promise<Record<string, any> | null>;
  loadConversation: (conversationId: string) => Promise<Record<string, any> | null>;
  loadAccount: (accountId: string) => Promise<Record<string, any>>;
  fetchAttachment: (attachmentId: string, tag: string, account: Record<string, any>) => Promise<Response>;
};

export async function serveMercadoLivreAttachment(messageId: string, index: number, dependencies: AttachmentProxyDependencies) {
  if (!await dependencies.authenticated()) return jsonError("Não autorizado.", 401);
  if (!messageId || !Number.isInteger(index) || index < 0) return jsonError("Anexo inválido.", 400);
  const message = await dependencies.loadMessage(messageId);
  if (!message) return jsonError("Mensagem não encontrada.", 404);
  const conversation = await dependencies.loadConversation(String(message.conversation_id || ""));
  if (!conversation || conversation.marketplace !== "mercado_livre" || !conversation.marketplace_account_id) {
    return jsonError("Anexo não autorizado para esta conversa.", 403);
  }
  const attachment = mercadoLivreAttachments(message.raw_data)[index];
  if (!attachment) return jsonError("Anexo não encontrado na mensagem.", 404);
  const account = await dependencies.loadAccount(String(conversation.marketplace_account_id));
  if (!account || account.marketplace !== "mercado_livre" || String(account.id) !== String(conversation.marketplace_account_id)) {
    return jsonError("Conta da conversa não autorizada.", 403);
  }
  const remote = await dependencies.fetchAttachment(attachment.id, attachment.tag, account);
  if (!remote.ok || !remote.body) {
    return jsonError(remote.status === 404 ? "Anexo indisponível no Mercado Livre." : "Não foi possível carregar o anexo.", remote.status === 404 ? 404 : 502);
  }
  const remoteContentType = remote.headers.get("content-type") || attachment.mimeType;
  if (attachment.isImage && !remoteContentType.toLowerCase().startsWith("image/")) {
    return jsonError("O Mercado Livre retornou um formato inválido para a imagem.", 502);
  }
  const headers = new Headers({
    "content-type": remoteContentType,
    "cache-control": "private, max-age=3600",
    "content-disposition": `${attachment.isImage ? "inline" : "attachment"}; filename="${safeFilename(attachment.name)}"`,
    "x-content-type-options": "nosniff"
  });
  const contentLength = remote.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  return new Response(remote.body, { status: 200, headers });
}

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });
}

function safeFilename(value: string) {
  return value.replace(/["\\\r\n]/g, "_").slice(0, 180) || "attachment";
}
