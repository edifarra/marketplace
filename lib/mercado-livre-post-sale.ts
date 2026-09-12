export const MLB_MESSAGING_AGENT_ID = "3037675074";

export type NormalizedMercadoLivreMessage = {
  marketplaceAccountId: string | null;
  messageId: string; orderId: string | null; packId: string | null; sellerId: string | null;
  conversationPath: string | null; conversationType: string; senderId: string | null;
  recipientId: string | null; counterpartyId: string | null; isMessagingAgent: boolean;
  direction: "incoming" | "outgoing"; text: string; sentAt: string; status: string | null;
  moderation: Record<string, any> | null; raw: Record<string, any>;
};

export function mercadoLivreMessageResourcePath(resource: unknown) {
  const clean = String(resource || "").trim();
  if (!clean) throw new Error("ID da mensagem Mercado Livre não informado.");
  const withoutOrigin = clean.replace(/^https:\/\/api\.mercadolibre\.com/i, "");
  if (/^\/?messages\//i.test(withoutOrigin)) return `/${withoutOrigin.replace(/^\//, "")}`;
  return `/messages/${withoutOrigin.replace(/^\//, "")}`;
}

export function normalizeMercadoLivrePostSale(payload: Record<string, any>, sellerId: string, marketplaceAccountId: string | null = null) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [payload];
  const rootPath = stringOrNull(payload.conversation_status?.path || payload.conversation_path);
  return messages.map((message): NormalizedMercadoLivreMessage => {
    const resources = Array.isArray(message.message_resources) ? message.message_resources : [];
    const resource = (name: string) => stringOrNull(resources.find((entry: any) => String(entry.name).toLowerCase() === name)?.id);
    const path = stringOrNull(message.conversation_status?.path || rootPath);
    const pathData = parseMercadoLivreConversationPath(path);
    const oldOrderId = String(message.resource || payload.resource || "").toLowerCase() === "orders"
      ? stringOrNull(message.resource_id || payload.resource_id) : null;
    const senderId = stringOrNull(message.from?.user_id || message.sender_id);
    const recipientId = stringOrNull(message.to?.user_id || message.recipient_id);
    const effectiveSeller = resource("sellers") || pathData.sellerId || stringOrNull(payload.seller_id) || sellerId || null;
    const direction = senderId && effectiveSeller && senderId === effectiveSeller ? "outgoing" : "incoming";
    const counterpartyId = direction === "incoming" ? senderId : recipientId;
    return {
      marketplaceAccountId,
      messageId: String(message.id || message.message_id || payload.message_id || ""),
      orderId: oldOrderId || stringOrNull(message.order_id || payload.order_id),
      packId: resource("packs") || pathData.packId || stringOrNull(message.pack_id || payload.pack_id),
      sellerId: effectiveSeller, conversationPath: path,
      conversationType: pathData.conversationType || String(payload.conversation_type || "post_sale"),
      senderId, recipientId, counterpartyId,
      isMessagingAgent: counterpartyId === MLB_MESSAGING_AGENT_ID || senderId === MLB_MESSAGING_AGENT_ID || recipientId === MLB_MESSAGING_AGENT_ID,
      direction, text: mercadoLivreMessageText(message), sentAt: mercadoLivreMessageDate(message),
      status: stringOrNull(message.status || payload.status),
      moderation: message.message_moderation || message.moderation || null, raw: message
    };
  }).filter(message => message.messageId);
}

export function mercadoLivreMessageText(message: Record<string, any>) {
  const value = message.text;
  if (typeof value === "string") return value;
  if (value && typeof value.plain === "string") return value.plain;
  const fallback = message.content?.text || message.message || "";
  return typeof fallback === "string" ? fallback : "";
}

export function parseMercadoLivreConversationPath(path: string | null) {
  const match = String(path || "").match(/\/packs\/([^/]+)\/sellers?\/([^/]+)(?:\/conversations\/([^/?]+))?/i);
  return { packId: match?.[1] || null, sellerId: match?.[2] || null, conversationType: match?.[3] || null };
}

export function canonicalMercadoLivreConversationId(input: { conversationPath?: string | null; packId?: string | null; orderId?: string | null; conversationType?: string | null }) {
  if (input.conversationPath) return `path:${input.conversationPath.replace(/\?.*$/, "").replace(/\/$/, "").toLowerCase()}`;
  const resourceId = input.packId || input.orderId;
  if (!resourceId) throw new Error("Não foi possível identificar o pack/pedido da conversa pós-compra.");
  return `post-sale:${resourceId}:${input.conversationType || "post_sale"}`;
}

function mercadoLivreMessageDate(message: Record<string, any>) {
  const value = message.message_date?.created || message.date_created || message.created_at || message.date || message.date_received;
  const date = value ? new Date(String(value)) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
function stringOrNull(value: unknown) { const text = String(value || "").trim(); return text || null; }
