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

import { claimDescription } from '../app/central-reclamacoes/case-display';
test('claim description uses the official enriched reason and keeps the buyer message separate',()=>{
  assert.equal(claimDescription({reason_name:'repentant_buyer',reason:'A minha compra chegou em boas condições, mas eu não a quero mais'}),'O comprador disse que chegou em boas condições, mas não quer mais o produto.');
  assert.equal(claimDescription({reason_name:'other',reason:'Outra descrição oficial'}),'Outra descrição oficial');
  assert.equal(claimDescription({reason_name:'repentant_buyer',reason_code:'PDD9939'}),'');
});

import { caseHeaderRow, caseReason, sellerDeadline } from '../app/central-reclamacoes/case-display';
test('a list opened before enrichment adopts the detail reason, reputation, deadline and action badge',()=>{
  const initial={marketplace:'mercado_livre',status:'opened',reason_code:'PDD9939',reputation_impact:'unknown',needs_action:null,group:'unknown',items:[],deadlines:[]};
  const row=caseHeaderRow(initial,{row:{reason_name:'repentant_buyer',reason:'Descrição oficial',reputation_impact:'not_affected',needs_action:true},items:[],deadlines:[{responsible:'seller',precision:'timestamp',value:'2026-10-09T02:37:00.000Z',purpose:'action:send_message_to_complainant'}]});
  assert.equal(caseReason(row),'O comprador se arrependeu');
  assert.equal(reputationLabel(row),'Não afeta sua reputação');
  assert.equal(sellerDeadline(row,row.deadlines),'2026-10-09T02:37:00.000Z');
  assert.equal(row.groupLabel,'Precisa de ação');
  const closed=caseHeaderRow(row,{row:{status:'closed',needs_action:true},items:[],deadlines:row.deadlines});
  assert.equal(closed.groupLabel,'Encerrado');assert.equal(sellerDeadline(closed,closed.deadlines),null);
  assert.equal(initial.reputation_impact,'unknown');
});
