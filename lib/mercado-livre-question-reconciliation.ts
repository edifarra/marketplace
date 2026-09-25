import { mercadoLivreQuestionRevision } from "./mercado-livre-conversation-reconciliation";

export type PendingMercadoLivreQuestion = {
  id: string;
  external_conversation_id: string;
  raw_data?: Record<string, any> | null;
};

export type PendingMercadoLivreQuestionDependencies = {
  loadQuestion: (questionId: string) => Promise<Record<string, any>>;
  persistQuestion: (question: Record<string, any>) => Promise<unknown>;
  markReconciled: (conversationId: string) => Promise<unknown>;
  markUnavailable: (conversationId: string, error: unknown) => Promise<unknown>;
};

export function isMercadoLivreQuestionNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch { /* respostas inesperadas continuam sendo erros */ }

  if (Number(payload?.status) !== 404) return false;
  const remoteError = String(payload?.error || payload?.code || "");
  const remoteMessage = String(payload?.message || "");
  return /(?:^|_)not_found(?:$|_)/i.test(remoteError) || /question\s+not\s+found/i.test(remoteMessage);
}

export async function reconcilePendingMercadoLivreQuestions(
  conversations: PendingMercadoLivreQuestion[],
  recentQuestionIds: ReadonlySet<string>,
  dependencies: PendingMercadoLivreQuestionDependencies
) {
  let checkedQuestions = 0;
  let changedQuestions = 0;
  let unavailableQuestions = 0;

  for (const conversation of conversations) {
    const questionId = String(conversation.external_conversation_id || "");
    if (!recentQuestionIds.has(questionId)) {
      let question: Record<string, any>;
      try {
        question = await dependencies.loadQuestion(questionId);
      } catch (error) {
        if (!isMercadoLivreQuestionNotFound(error)) throw error;
        await dependencies.markUnavailable(String(conversation.id), error);
        checkedQuestions += 1;
        unavailableQuestions += 1;
        continue;
      }
      if (mercadoLivreQuestionRevision(conversation.raw_data || {}) !== mercadoLivreQuestionRevision(question)) {
        await dependencies.persistQuestion(question);
        changedQuestions += 1;
      }
    }
    await dependencies.markReconciled(String(conversation.id));
    checkedQuestions += 1;
  }

  return { checkedQuestions, changedQuestions, unavailableQuestions };
}
