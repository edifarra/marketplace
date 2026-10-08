import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCase } from "../lib/marketplace-case-domain";
import { shopeeReturnPushMilestones } from "../lib/shopee-return-milestones";
import { shopeeTimeline } from "../app/central-reclamacoes/shopee-presentation";
import { elements, loadPage, memoryDatabase, textContent } from "./helpers/page-harness";
import { loadCaseDetail } from "../lib/marketplace-case-detail";
import * as display from "../app/central-reclamacoes/case-display";

// Shape and epoch values observed in the authorized read-only audit; identities/media are synthetic.
const activityId = "94ab2b1d-e17c-43d6-b96e-5bc5e0c0d272";
const payload = (changes: any[]) => ({ code: 29, shop_id: 123, data: { return_sn: "R-TEST", order_sn: "O-TEST", updated_values: changes } });
const requested = payload([{ update_field: "return_status", old_value: "", new_value: "PROCESSING", update_time: 1790861864 }]);
const posted = payload([{ update_field: "logistics_status", old_value: "LOGISTICS_REQUEST_CREATED", new_value: "LOGISTICS_PICKUP_DONE", update_time: 1791037288 }]);

test("observed detail preserves creation and buyer video in the existing persistence contract", () => {
  const result = normalizeCase({ id: activityId, marketplace: "shopee", raw_payload: requested, received_at: "2026-10-06T18:21:10Z" }, "account", {
    return_sn: "R-TEST", order_sn: "O-TEST", create_time: 1790861863, update_time: 1791310869,
    status: "PROCESSING", validation_type: "seller_validation", buyer_videos: [
      { video_url: "https://example.com/evidence.mp4", thumbnail_url: "https://example.com/cover.jpg" },
      { video_url: "javascript:alert(1)" }, { video_url: "https://example.com/?access_token=secret" },
    ], return_seller_due_date: 1791570065,
  })!;
  assert.equal(result.snapshot.return_created_at, "2026-10-01T13:37:43.000Z");
  assert.equal(result.official_at, "2026-10-06T18:21:09.000Z");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].media_type, "video");
  assert.equal(result.evidence[0].metadata.thumbnail_url, "https://example.com/cover.jpg");
  assert.equal(result.deadlines[0].value, "2026-10-09T18:21:05.000Z");
  assert.equal(result.deadlines[0].purpose, "seller_response");
});

test("push occurrence differs from receipt, processing, deadline and update time", () => {
  assert.equal(shopeeReturnPushMilestones({ ...requested, timestamp: 1791310869 })[0].at, "2026-10-01T13:37:44.000Z");
  assert.equal(shopeeReturnPushMilestones(posted)[0].kind, "buyer_posted");
  assert.match(display.caseDate(shopeeReturnPushMilestones(posted)[0].at), /03\/10\/2026.*11:21:28/);
  for (const update_time of [null, 0, "invalid"]) assert.deepEqual(shopeeReturnPushMilestones(payload([{ update_field: "return_status", new_value: "PROCESSING", update_time }])), []);
  assert.deepEqual(shopeeReturnPushMilestones({ ...posted, code: 3 }), []);
});

test("the four steps use proven creation/posting dates, never invent seller validation or closure dates", () => {
  const row = { status: "PROCESSING", validation_type: "seller_validation", reverse_logistics: { status: "LOGISTICS_DELIVERY_DONE" }, return_created_at: "2026-10-01T13:37:43.000Z", return_milestones: [...shopeeReturnPushMilestones(requested), ...shopeeReturnPushMilestones(posted)] };
  const steps = shopeeTimeline(row, [{ official_at: "2026-10-06T18:21:09Z", state: { stage: "seller_validation" } }], [{ purpose: "seller_response", responsible: "seller", value: "2026-10-09T18:21:05Z" }]).steps;
  assert.deepEqual(steps.map(s => s.progress), ["complete", "complete", "current", "pending"]);
  assert.equal(steps[0].date, row.return_created_at);
  assert.equal(steps[1].date, "2026-10-03T14:21:28.000Z");
  assert.equal(steps[1].dateLabel, "Postagem confirmada em");
  assert.equal(steps[2].date, null); assert.equal(steps[3].date, null);
  assert.equal(shopeeTimeline({ ...row, return_created_at: null }, []).steps[0].dateLabel, "Notificação da solicitação");
});

test("legacy dates recover only from activities linked to the case observations, never remote API", async () => {
  const db = memoryDatabase({ marketplace_cases: [{ id: "case", marketplace: "shopee", external_case_id: "R-TEST", order_id: "O-TEST" }], marketplace_case_observations: [{ id: "obs", source_key: activityId + ":local" }], marketplace_activities: [{ id: activityId, raw_payload: posted }, { id: "other", raw_payload: { ...posted, data: { ...posted.data, return_sn: "OTHER" } } }] });
  const detail = await loadCaseDetail("case", db as any);
  assert.equal(detail?.row.return_milestones.length, 1);
  assert.equal(detail?.row.return_milestones[0].kind, "buyer_posted");
  const ids = db.calls.find(c => c.table === "marketplace_activities" && c.method === "in");
  assert.deepEqual(ids?.args, ["id", [activityId]]);
});

test("Shopee refund is disabled without a proven financial API contract and absent for ineligible states", () => {
  const { ShopeeActions } = loadPage("app/central-reclamacoes/shopee-actions.tsx", { "./case-display": display, react: { useState: (initial: () => number) => [initial(), () => {}] } });
  const row = { id: "case", status: "PROCESSING", validation_type: "seller_validation", reverse_logistics: { status: "LOGISTICS_DELIVERY_DONE" } };
  const deadlines = [{ purpose: "seller_response", responsible: "seller", precision: "timestamp", value: "2026-10-09T18:21:05Z" }];
  const tree = ShopeeActions({ row, deadlines, now: Date.parse("2026-10-10T00:00:00Z") });
  const button = elements(tree).find(n => n.type === "button");
  assert.equal(button.props.disabled, true); assert.equal(button.props.onClick, undefined);
  assert.match(textContent(tree), /Prazo expirado/); assert.match(textContent(tree), /Para disputa, acesse o site da Shopee\./);
  for (const status of ["CLOSED", "CANCELLED", "REQUESTED", "UNKNOWN"]) assert.equal(elements(ShopeeActions({ row: { ...row, status }, deadlines })).some(n => n.type === "button"), false);
});

test("ML timeline starts at the end but leaves manual historical reading untouched", () => {
  const refs: any[] = []; const effects: Array<() => void> = []; let cursor = 0;
  const react = { useRef(initial: any) { const index = cursor++; refs[index] ||= { current: initial }; return refs[index]; }, useLayoutEffect(fn: () => void) { effects.push(fn); } };
  const { CaseTimeline } = loadPage("app/central-reclamacoes/case-timeline.tsx", { react, "./case-display": display, "./case-presentation": { humanLabel: (v: string) => v, timelineFields: () => [] }, "./shopee-presentation": { shopeeTimeline } });
  const events = [{ id: "1", event_type: "Evento", state: {} }];
  const tree = CaseTimeline({ row: { marketplace: "mercado_livre" }, events });
  const scroll = elements(tree).find(n => n.props["aria-label"] === "Eventos do caso em ordem cronológica");
  const node = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }; refs[0].current = node;
  effects.pop()!(); assert.equal(node.scrollTop, 1000);
  node.scrollTop = 100; scroll.props.onScroll();
  node.scrollHeight = 1100; cursor = 0;
  CaseTimeline({ row: { marketplace: "mercado_livre" }, events: [...events] });
  effects.pop()!(); assert.equal(node.scrollTop, 100);
  node.scrollTop = 700; scroll.props.onScroll(); node.scrollHeight = 1200; cursor = 0;
  CaseTimeline({ row: { marketplace: "mercado_livre" }, events: [...events] });
  effects.pop()!(); assert.equal(node.scrollTop, 1200);
});
