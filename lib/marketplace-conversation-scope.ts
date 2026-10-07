// An order with an open/closed case does not change its normal chat's scope.
export const CHAT_CONVERSATION_TYPES = ["question", "chat", "post_sale"];

export function isChatConversation(row: { conversation_type?: string | null }) {
  return CHAT_CONVERSATION_TYPES.includes(row.conversation_type || "");
}

export function assertChatReplyChannel(row: { conversation_type?: string | null }) {
  if (!isChatConversation(row)) {
    throw new Error("Este atendimento pertence à Central de Reclamações e Devoluções. Responda pelo caso oficial.");
  }
}
