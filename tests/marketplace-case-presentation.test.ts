import test from "node:test";
import assert from "node:assert/strict";
import { buyerFields, humanLabel, returnFields, timelineFields } from "../app/central-reclamacoes/case-presentation";
import { caseReason, caseStatusLabel, reputationLabel } from "../app/central-reclamacoes/case-display";

test("return fields share labels and only use persisted tracking in both marketplaces", () => {
  for (const marketplace of ["mercado_livre", "shopee"]) {
    const row = { marketplace, case_type: "claim", external_case_id: "claim-1", reverse_logistics: { return_id: "return-1", contact_name: "Maria", status: "LOGISTICS_DELIVERY_DONE", tracking: "BR262396707475A" } };
    const original = structuredClone(row);
    assert.deepEqual(returnFields(row), [["ID da devolução", "return-1"], ["Nome logístico da devolução", "Maria"], ["Logística reversa", "Entregue"], ["Código de retorno", "BR262396707475A"]]);
    assert.deepEqual(row, original);
    assert.equal(returnFields({ ...row, reverse_logistics: { return_id: "return-1", tracking: "   ", shipment_id: "other-id" } }).some(([label]) => label === "Código de retorno"), false);
    assert.deepEqual(returnFields({ ...row, reverse_logistics: {} }), []);
  }
});
test("Shopee reasons and states are readable; unknown internal values stay hidden", () => {
  const row = { marketplace: "shopee", reason_code: "FUNCTIONAL_DMG", status: "PROCESSING", reverse_logistics: { status: "LOGISTICS_DELIVERY_DONE" } };
  assert.equal(caseReason(row), "Produto com defeito de funcionamento");
  assert.equal(caseStatusLabel(row), "Entregue");
  assert.equal(humanLabel("seller_validation"), "Validação pelo vendedor");
  assert.equal(humanLabel("NOT_NEEDED"), "Não necessário");
  assert.equal(humanLabel("UNRECOGNIZED_STATE"), null);
  assert.equal(reputationLabel(row), "");
  assert.deepEqual(timelineFields({ status: "PROCESSING", stage: "seller_validation", responsible: "seller", logistics_status: "LOGISTICS_DELIVERY_DONE", internal: "NOT_NEEDED" }), [["Situação", "Em processamento"], ["Etapa", "Validação pelo vendedor"], ["Responsável", "Vendedor"], ["Logística reversa", "Entregue"]]);
});
test("buyer section only uses available buyer fields, never logistics or recipient", () => {
  assert.deepEqual(buyerFields({ reverse_logistics: { contact_name: "Destinatário" }, recipient: { name: "Outro" } }), []);
  assert.deepEqual(buyerFields({ marketplace: "shopee", buyer_name: "Comprador oficial" }), [["Nome público", "Comprador oficial"]]);
  assert.deepEqual(buyerFields({ buyer_data: { display_name: "Ana", document_number: "123" } }), [["Nome público", "Ana"], ["Documento", "123"]]);
});
