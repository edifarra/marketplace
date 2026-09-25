import assert from "node:assert/strict";
import test from "node:test";
import {
  isMercadoLivreQuestionNotFound,
  reconcilePendingMercadoLivreQuestions
} from "../lib/mercado-livre-question-reconciliation";

const notFound = () => new Error(JSON.stringify({ message: "Question not found", error: "not_found", status: 404, cause: [] }));

test("404 Question not found terminaliza somente a pergunta e continua as etapas seguintes", async () => {
  const loaded: string[] = [];
  const unavailable: string[] = [];
  const reconciled: string[] = [];
  let laterAccountStageExecuted = false;

  const result = await reconcilePendingMercadoLivreQuestions([
    { id: "conversation-missing", external_conversation_id: "question-missing", raw_data: { id: "question-missing", status: "UNANSWERED" } },
    { id: "conversation-next", external_conversation_id: "question-next", raw_data: { id: "question-next", status: "UNANSWERED" } }
  ], new Set(), {
    loadQuestion: async questionId => {
      loaded.push(questionId);
      if (questionId === "question-missing") throw notFound();
      return { id: questionId, status: "UNANSWERED" };
    },
    persistQuestion: async () => undefined,
    markReconciled: async id => { reconciled.push(id); },
    markUnavailable: async id => { unavailable.push(id); }
  });
  laterAccountStageExecuted = true;

  assert.deepEqual(loaded, ["question-missing", "question-next"]);
  assert.deepEqual(unavailable, ["conversation-missing"]);
  assert.deepEqual(reconciled, ["conversation-next"]);
  assert.equal(result.checkedQuestions, 2);
  assert.equal(result.unavailableQuestions, 1);
  assert.equal(laterAccountStageExecuted, true);
});

test("estado terminal persistido usa as colunas existentes exigidas", async () => {
  const update: Record<string, unknown> = {};
  await reconcilePendingMercadoLivreQuestions([
    { id: "conversation-missing", external_conversation_id: "question-missing" }
  ], new Set(), {
    loadQuestion: async () => { throw notFound(); },
    persistQuestion: async () => undefined,
    markReconciled: async () => undefined,
    markUnavailable: async (_id, error) => {
      Object.assign(update, {
        status: "closed", external_status: "NOT_FOUND / REMOTE_UNAVAILABLE",
        requires_response: false, unread: false,
        last_error: error instanceof Error ? error.message : String(error),
        last_reconciled_at: new Date().toISOString()
      });
    }
  });
  assert.equal(update?.status, "closed");
  assert.equal(update?.requires_response, false);
  assert.equal(update?.unread, false);
  assert.match(String(update?.external_status), /NOT_FOUND/);
  assert.match(String(update?.last_error), /Question not found/);
  assert.ok(!Number.isNaN(Date.parse(String(update?.last_reconciled_at))));
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`${status} permanece erro`, async () => {
    const error = new Error(JSON.stringify({ message: "remote failure", error: status === 404 ? "not_found" : "failure", status }));
    await assert.rejects(reconcilePendingMercadoLivreQuestions([
      { id: "conversation", external_conversation_id: "question" }
    ], new Set(), {
      loadQuestion: async () => { throw error; },
      persistQuestion: async () => undefined,
      markReconciled: async () => undefined,
      markUnavailable: async () => assert.fail("erro real não pode ser terminalizado")
    }), candidate => candidate === error);
  });
}

test("404 genérico e erro inesperado não são convertidos silenciosamente", async () => {
  assert.equal(isMercadoLivreQuestionNotFound(new Error(JSON.stringify({ status: 404, error: "resource_missing", message: "Item not found" }))), false);
  assert.equal(isMercadoLivreQuestionNotFound(new Error("socket disconnected")), false);
  assert.equal(isMercadoLivreQuestionNotFound(notFound()), true);
});
