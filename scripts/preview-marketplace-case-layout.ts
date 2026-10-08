// Isolated visual fixture: real components/CSS, synthetic data, no database or marketplace calls.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadPage } from "../tests/helpers/page-harness";
import * as display from "../app/central-reclamacoes/case-display";
import * as presentation from "../app/central-reclamacoes/case-presentation";
import * as shopee from "../app/central-reclamacoes/shopee-presentation";

const css = { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) };
const hooks = { useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}], useRef: (initial: any) => ({ current: initial }), useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (fn: any) => fn };
const shared = { react: hooks, "./case-display": display, "./case-presentation": presentation, "./shopee-presentation": shopee, "./cases.module.css": css };
const { CaseTimeline } = loadPage("app/central-reclamacoes/case-timeline.tsx", shared);
const { CaseEvidence } = loadPage("app/central-reclamacoes/case-evidence.tsx", { ...shared, "next/image": { __esModule: true, default: (props: any) => createElement("img", { ...props, unoptimized: undefined, src: "/fixture.svg" }) } });
const { ShopeeActions } = loadPage("app/central-reclamacoes/shopee-actions.tsx", shared);
const { ClaimControls } = loadPage("app/central-reclamacoes/claim-controls.tsx", { ...shared, "next/navigation": { useRouter: () => ({ refresh() {} }) }, "@/lib/marketplace-claim-domain": { CLAIM_ACTION_LABELS: { refund: "Reembolsar integralmente", allow_partial_refund: "Oferecer reembolso parcial", allow_return: "Oferecer devolução" } } });
let fixture: any;
const { CaseDetail } = loadPage("app/central-reclamacoes/case-grid.tsx", { ...shared,
  react: { ...hooks, useState: (initial: any) => [initial === null ? fixture : initial, () => {}] },
  "./case-detail-cache": { detailCacheKey: () => "fixture" },
  "./case-timeline": { CaseTimeline }, "./case-evidence": { CaseEvidence }, "./shopee-actions": { ShopeeActions }, "./claim-controls": { ClaimControls }, "@/lib/marketplace-case-context": {},
});
const style = readFileSync("app/central-reclamacoes/cases.module.css", "utf8");
createServer((request, response) => {
  if (request.url === "/fixture.svg") { response.setHeader("Content-Type", "image/svg+xml"); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#e4e7ec"/><text x="160" y="125" text-anchor="middle" font-family="Arial" fill="#667085">Evidência fictícia</text></svg>'); return; }
  const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
  const marketplace = query.get("marketplace") === "mercado_livre" ? "mercado_livre" : "shopee";
  fixture = {
    row: { id: "fixture", marketplace, marketplace_account_id: "fixture-account", case_type: "claim", external_case_id: "TESTE-LOCAL", order_id: "PEDIDO-LOCAL", status: marketplace === "shopee" ? "PROCESSING" : "opened", validation_type: "seller_validation", reason: "Produto com defeito", refund_amount: 29, currency: "BRL", buyer_description: "Descrição fictícia para validação do layout.", buyer_name: query.get("buyer") === "0" ? null : "Comprador de teste", reverse_logistics: { status: "LOGISTICS_DELIVERY_DONE", tracking: "BR-TESTE", modality: "Coleta" }, return_created_at: "2026-10-01T13:37:43Z", return_milestones: [{ kind: "buyer_posted", source: "shopee:push29", at: "2026-10-03T14:21:28Z" }] },
    conversation: { id: "fixture-chat" }, messageScope: marketplace === "shopee" ? "order_context" : "case",
    messages: Array.from({ length: 24 }, (_, index) => ({ id: `message-${index}`, direction: index % 2 ? "incoming" : "outgoing", text: `Mensagem fictícia ${index + 1} — histórico para testar rolagem interna.`, sent_at: "2026-10-07T12:00:00Z" })),
    items: [{ sku: "SKU-TESTE", quantidade: 1, valor_total: 29, product: { title: "Produto de teste" } }],
    deadlines: [{ purpose: "seller_response", responsible: "seller", precision: "timestamp", value: "2026-10-09T18:21:05Z" }],
    evidence: [{ id: "image", media_type: "image", reference: "https://example.com/fixture.jpg" }],
    timeline: Array.from({ length: 25 }, (_, index) => ({ id: `event-${index}`, event_type: `Evento fictício ${index + 1}`, official_at: "2026-10-07T12:00:00Z", state: { responsible: "seller" } })),
    actions: ["refund", "allow_partial_refund", "allow_return"].map(action_code => ({ action_code })),
  };
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia isolada da Central</title><style>*{box-sizing:border-box}body{font:14px Arial;background:#f8fafc;margin:0;padding:20px;color:#344054}main{max-width:1200px;margin:auto}button{border:1px solid #d0d5dd;padding:8px;background:white;color:#344054;border-radius:8px}button:disabled{opacity:.6}h1{font-size:20px}h3{font-size:14px}.muted{color:#667085}.chat-message{padding:12px;border-radius:8px;background:white}.form-error{color:#b42318}a{color:#175cd3}${style}</style><main><p>Prévia isolada · dados fictícios · nenhuma operação remota</p>${renderToStaticMarkup(CaseDetail({ id: "fixture" }))}</main></html>`);
}).listen(3137, "127.0.0.1", () => console.log("Visual fixture: http://127.0.0.1:3137/?marketplace=shopee"));
