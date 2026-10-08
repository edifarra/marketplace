import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shopeeTimeline, evidenceUrl } from "../app/central-reclamacoes/shopee-presentation";
import { elements, loadPage, textContent, memoryDatabase } from "./helpers/page-harness";
import * as display from "../app/central-reclamacoes/case-display";
import * as presentation from "../app/central-reclamacoes/case-presentation";
import { loadCaseDetail } from "../lib/marketplace-case-detail";

test("detail reuses the existing read to expose refund, currency and stage without remote calls", async () => {
  const db = memoryDatabase({ marketplace_cases: [{ id: "local", marketplace: "shopee", external_case_id: "return-1", refund_amount: 0, currency: "BRL", stage: "seller_validation" }] });
  const result = await loadCaseDetail("local", db as any);
  assert.equal(result?.row.refund_amount, 0);
  const query = db.calls.find(c => c.table === "marketplace_cases" && c.method === "select");
  assert.match(query?.args[0], /refund_amount:content->refund_amount/);
  assert.match(query?.args[0], /currency:content->>currency/);
  assert.match(query?.args[0], /,stage,/);
});

test("Shopee keeps ambiguous and skipped stages unconfirmed, never assumes completed shipping", () => {
  for (const status of ["PROCESSING", "ACCEPTED", "JUDGING", "SELLER_DISPUTE", "FUTURE_STATUS", null]) {
    const model = shopeeTimeline({ status }, []);
    assert.equal(model.ambiguous, true);
    assert.ok(model.steps.every(s => s.progress !== "current" && s.progress !== "complete"));
  }
  for (const status of ["CLOSED", "CANCELLED"]) {
    const steps = shopeeTimeline({ status }, []).steps;
    assert.deepEqual(steps.map(s => s.progress), ["complete", "unknown", "unknown", "current"]);
  }
  assert.deepEqual(shopeeTimeline({ status: "REQUESTED" }, []).steps.map(s => s.progress), ["current", "pending", "pending", "pending"]);
  assert.equal(shopeeTimeline({ status: "PROCESSING", reverse_logistics: { status: "LOGISTICS_READY" } }, [], [{ purpose: "buyer_return_shipping", responsible: "buyer", value: "2026-10-10" }]).steps[1].progress, "current");
  assert.equal(shopeeTimeline({ status: "PROCESSING", reverse_logistics: { status: "LOGISTICS_READY" } }, []).ambiguous, true);
  assert.equal(shopeeTimeline({ status: "PROCESSING", reverse_logistics: { status: "LOGISTICS_DELIVERY_DONE" } }, []).ambiguous, true);
  const events = [{ state: { stage: "awaiting_buyer_shipping" }, observed_at: "2026-10-01T00:00:00Z" }];
  const steps = shopeeTimeline({ stage: "seller_validation" }, events).steps;
  assert.equal(steps[1].progress, "complete");
  assert.equal(steps[1].date, null);
  assert.equal(steps[2].progress, "current");
  assert.equal(shopeeTimeline({ status: "REQUESTED" }, [{ state: { status: "REQUESTED" }, official_at: "2026-10-01T00:00:00Z" }]).steps[0].date, "2026-10-01T00:00:00Z");
});

test("both timeline renders contain no bold nodes and ML preserves all event information", () => {
  const { CaseTimeline } = loadPage("app/central-reclamacoes/case-timeline.tsx", { "./case-display": display, "./case-presentation": presentation, "./shopee-presentation": { shopeeTimeline } });
  for (const marketplace of ["shopee", "mercado_livre"]) {
    const tree = CaseTimeline({ row: { marketplace, status: "REQUESTED" }, events: [{ id: "1", event_type: "Produto entregue", official_at: "2026-10-01T00:00:00Z", state: { responsible: "seller" } }, { id: "2", event_type: "Reclamação aberta", state: {} }] });
    const nodes = elements(tree);
    assert.equal(nodes.some(n => ["b", "strong"].includes(n.type)), false);
    if (marketplace === "shopee") assert.equal(nodes.filter(n => n.type === "li").length, 4);
    else { assert.ok(textContent(tree).includes("Produto entregue")); assert.ok(textContent(tree).includes("Reclamação aberta")); assert.ok(textContent(tree).includes("Responsável: Vendedor")); }
  }
});

test("evidence previews use safe URLs; images enlarge and videos never autoplay", () => {
  for (const value of ["javascript:alert(1)", "http://example.com/a.jpg", "opaque-reference", "https://user:pass@example.com/a", "https://example.com/?access_token=secret"]) assert.equal(evidenceUrl(value), null);
  const { CaseEvidence } = loadPage("app/central-reclamacoes/case-evidence.tsx", { "./shopee-presentation": { evidenceUrl } });
  const nodes = elements(CaseEvidence({ evidence: [{ id: "1", media_type: "image", reference: "https://example.com/photo.jpg" }, { id: "2", media_type: "video", reference: "https://example.com/video.mp4" }, { id: "3", media_type: "image", reference: "opaque" }] }));
  assert.ok(nodes.some(n => n.type === "img"));
  const video = nodes.find(n => n.type === "video");
  assert.equal(video.props.controls, true); assert.equal(video.props.preload, "none"); assert.equal(video.props.autoPlay, undefined);
  assert.ok(nodes.some(n => n.type === "a" && n.props.target === "_blank"));
});

test("actual detail keeps chat history left and timeline after buyer on right, preserving fields", () => {
  const data = { row: { marketplace: "shopee", external_case_id: "return-1", reason_code: "FUNCTIONAL_DMG", refund_amount: 25, currency: "BRL", buyer_description: "Não funciona", buyer_name: "Ana", reverse_logistics: { tracking: "BR123", modality: "Coleta" } }, messages: [], items: [], deadlines: [], timeline: [], evidence: [], actions: [] };
  const mocks = { react: { useState: (initial: any) => [initial === null ? data : initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (fn: any) => fn }, "./case-display": display, "./case-presentation": presentation, "@/lib/marketplace-case-context": {}, "./cases.module.css": { __esModule: true, default: new Proxy({}, { get: (_t, key) => key }) } };
  const { CaseDetail } = loadPage("app/central-reclamacoes/case-grid.tsx", mocks);
  const tree = CaseDetail({ id: "case-1" }); const nodes = elements(tree);
  const right = nodes.find(n => n.props.className === "rightColumn"); const left = nodes.find(n => n.props.className === "leftColumn");
  assert.ok(right); assert.ok(left);
  assert.ok(elements(right).some(n => n.type === "test-component:CaseTimeline"));
  assert.equal(elements(left).some(n => n.type === "test-component:CaseTimeline"), false);
  for (const label of ["Reembolso solicitado", "Resultado solicitado", "Motivo da devolução", "Descrição do comprador"]) assert.ok(elements(left).some(n => n.props.label === label));
  for (const label of ["ID do Caso", "Código de retorno", "Modalidade de envio"]) assert.ok(elements(right).some(n => n.props.label === label));
  data.row.marketplace = "mercado_livre";
  const ml = elements(CaseDetail({ id: "case-1" }));
  assert.ok(elements(ml.find(n => n.props.className === "rightColumn")).some(n => n.type === "test-component:CaseTimeline"));
  const css = readFileSync("app/central-reclamacoes/cases.module.css", "utf8");
  assert.match(css, /@media\(max-width:550px\)/); assert.match(css, /font-weight:400/);
});
