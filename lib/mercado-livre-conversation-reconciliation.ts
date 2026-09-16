import { normalizeMercadoLivrePostSale } from "./mercado-livre-post-sale";

export function mercadoLivreQuestionRevision(question: Record<string, any>) {
  return JSON.stringify({
    id: String(question.id || ""), status: String(question.status || ""), deleted: question.deleted_from_listing === true,
    answerId: String(question.answer?.id || ""), answerText: String(question.answer?.text || ""), answerDate: String(question.answer?.date_created || "")
  });
}

export function mercadoLivrePostSaleRevision(payload: Record<string, any>, sellerId: string) {
  return JSON.stringify({
    status: String(payload.conversation_status?.status || payload.status || "active"),
    messages: normalizeMercadoLivrePostSale(payload, sellerId).map(message => [message.messageId, message.direction, message.status, message.text, message.sentAt])
  });
}
