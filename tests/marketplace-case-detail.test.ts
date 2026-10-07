import test from "node:test";
import assert from "node:assert/strict";
import { safeCaseConversation } from "../lib/marketplace-case-detail";
import { reputationLabel } from "../app/central-reclamacoes/case-display";
const base = { id: "c", marketplace: "shopee", marketplace_account_id: "account", order_id: "order", conversation_type: "chat", buyer_id: "buyer", sku: "SKU" };
test("chat requires one exact marketplace/account/order result, never buyer or SKU", () => {
  assert.equal(safeCaseConversation([base], "shopee", "account", "order")?.id, "c");
  for (const wrong of [{ ...base, marketplace: "mercado_livre" }, { ...base, marketplace_account_id: "other" }, { ...base, order_id: "other" }, { ...base, conversation_type: "question" }]) assert.equal(safeCaseConversation([wrong], "shopee", "account", "order"), null);
  assert.equal(safeCaseConversation([base], "shopee", "account", null), null);
  assert.equal(safeCaseConversation([base, { ...base, id: "ambiguous" }], "shopee", "account", "order"), null);
  assert.equal(safeCaseConversation([], "shopee", "account", "order"), null);
});
test("Shopee never gets inferred or accidentally copied reputation", () => {
  for (const reputation_impact of [null, "unknown", "affected", "not_affected"]) assert.equal(reputationLabel({ marketplace: "shopee", reputation_impact }), "Reputação: Não informado");
  assert.equal(reputationLabel({ marketplace: "mercado_livre", reputation_impact: "affected" }), "Afeta sua reputação");
  assert.equal(reputationLabel({ marketplace: "mercado_livre", reputation_impact: "not_affected" }), "Não afeta sua reputação");
});
