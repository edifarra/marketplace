import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { historyCacheFresh, recoverClaimChatHistory, priorClaimChatMessages, type HistoryDependencies } from "../lib/marketplace-claim-chat-history";
import { normalizeMercadoLivrePostSale } from "../lib/mercado-livre-post-sale";
import { marketplaceMessageType } from "../lib/marketplace-special-messages";
import { loadMercadoLivreClaimBundle } from "../lib/marketplace-case-enrichment";

const now = Date.parse("2026-10-11T12:00:00Z"), claimAt = "2026-10-11T10:00:00Z";
const account = { id: "ML-GI", seller_id: "181345701", name: "ML-GI" };
const order = { id: "2000018889505456", seller: { id: account.seller_id } };
function fixture(pack = order.id) {
  const cache = new Map<string, any>(), saved = new Map<string, any>(); let reads = 0, writes = 0;
  const remote = { messages: Array.from({ length: 6 }, (_, i) => ({ id: `official-${i}`, from: { user_id: i === 1 || i === 5 ? account.seller_id : "buyer" },
    message_resources: [{ name: "packs", id: pack }, { name: "sellers", id: account.seller_id }],
    message_date: { created: `2026-10-10T${String(12 + i).padStart(2, "0")}:00:00Z` }, text: i === 3 ? "" : `Texto completo ${i}`,
    ...(i === 3 ? { message_attachments: [{ filename: "picture.jpg", type: "image/jpeg" }] } : {}) })) };
  const deps: HistoryDependencies = {
    acquire: async (key, at, time) => { if (historyCacheFresh(cache.get(key) || {}, at, time)) return false; cache.set(key, { result: "processing", retryAt: new Date(time + 900000).toISOString() }); return true; },
    finish: async (key, value) => { cache.set(key, value); },
    read: async path => { reads++; assert.equal(path, `/packs/${pack}/sellers/${account.seller_id}`); return remote; },
    persist: async (payload, context) => { writes++; assert.equal(context.orderId, order.id); assert.equal(context.packId, pack);
      for (const m of normalizeMercadoLivrePostSale(payload, account.seller_id, account.id)) saved.set(`${m.marketplaceAccountId}:${pack}:${m.messageId}`, m); }
  };
  return { deps, cache, saved, remote, reads: () => reads, writes: () => writes };
}
for (const pack of [order.id, "distinct-pack"]) test(`answered chat absent from unread/database recovered by ${pack === order.id ? "order_id" : "pack_id"}`, async () => {
  const f = fixture(pack);
  assert.equal(await recoverClaimChatHistory(account, { ...order, pack_id: pack }, claimAt, f.deps, now), "success");
  assert.equal(f.saved.size, 6); assert.equal(f.reads(), 1);
  const image = [...f.saved.values()][3]; assert.equal(image.text, ""); assert.equal(marketplaceMessageType(image.raw), "image"); assert.equal(image.direction, "incoming");
  assert.equal([...f.saved.values()][5].direction, "outgoing");
  assert.equal(await recoverClaimChatHistory(account, { ...order, pack_id: pack }, claimAt, f.deps, now + 3600000), "cached");
  assert.equal(f.reads(), 1);
  // Lost cache/reconciliation replays official IDs through an idempotent writer.
  f.cache.clear(); await recoverClaimChatHistory(account, { ...order, pack_id: pack }, claimAt, f.deps, now + 7200000); assert.equal(f.saved.size, 6);
});
test("persisted success reused and newer claim refreshes only when coverage is insufficient", () => {
  assert.equal(historyCacheFresh({ result: "success", coveredThrough: new Date(now).toISOString() }, claimAt, now + 86400000), true);
  assert.equal(historyCacheFresh({ result: "success", coveredThrough: claimAt }, new Date(now).toISOString(), now), false);
});
test("account/order/seller mismatch never associates messages", async () => {
  const f = fixture(); assert.equal(await recoverClaimChatHistory({ ...account, seller_id: "other" }, order, claimAt, f.deps, now), "invalid_identity"); assert.equal(f.reads(), 0);
  f.remote.messages[0].message_resources[1].id = "other";
  assert.equal(await recoverClaimChatHistory(account, order, claimAt, f.deps, now), "transient_error"); assert.equal(f.saved.size, 0);
});
for (const status of [404, 503]) test(`${status}: failure isolated, retry controlled and not permanent`, async () => {
  const f = fixture(); let attempts = 0;
  f.deps.read = async () => { attempts++; throw Object.assign(new Error("remote failure"), { status }); };
  const outcome = status === 404 ? "not_found" : "transient_error", ttl = (status === 404 ? 60 : 15) * 60000;
  assert.equal(await recoverClaimChatHistory(account, order, claimAt, f.deps, now), outcome);
  assert.equal(await recoverClaimChatHistory(account, order, claimAt, f.deps, now + ttl - 1), "cached"); assert.equal(attempts, 1);
  assert.equal(await recoverClaimChatHistory(account, order, claimAt, f.deps, now + ttl), outcome); assert.equal(attempts, 2);
});
test("account cache partitions and concurrent requests coalesce", async () => {
  const f = fixture(); await Promise.all([1, 2, 3].map(() => recoverClaimChatHistory(account, order, claimAt, f.deps, now))); assert.equal(f.reads(), 1);
  await recoverClaimChatHistory({ ...account, id: "ML-ED" }, order, claimAt, f.deps, now); assert.equal(f.reads(), 2); assert.equal(f.cache.size, 2);
});
test("history is sorted before cutoff, deduplicated by official ID and retains empty attachments", () => {
  const messages = [{ id: "b", external_message_id: "2", sent_at: "2026-10-10T18:00:00Z", text: "" }, { id: "a", external_message_id: "1", sent_at: "2026-10-09T18:00:00Z" }, { id: "c", external_message_id: "3", sent_at: claimAt }];
  assert.deepEqual(priorClaimChatMessages([...messages, messages[0]], claimAt).map(m => m.id), ["a", "b"]);
  assert.deepEqual(priorClaimChatMessages(messages, claimAt, [{ external_message_id: "2" }]).map(m => m.id), ["a"]);
  assert.deepEqual(priorClaimChatMessages(messages, null), []);
});
test("failure in optional history keeps official claim bundle functional", async () => {
  const detail = { id: "claim", resource: "order", resource_id: order.id, date_created: claimAt, players: [{ role: "respondent", type: "seller", user_id: account.seller_id }, { role: "complainant", type: "buyer", user_id: "buyer" }] };
  const bundle = await loadMercadoLivreClaimBundle("claim", account as any, async path => path.endsWith("/claims/claim") ? detail : path.startsWith("/orders/") ? { ...order, buyer: { id: "buyer" } } : {}, async () => { throw new Error("history unavailable"); });
  assert.equal(bundle.id, "claim"); assert.ok(bundle.__case_enrichment.messages);
});
test("read paths stay local, response channel unchanged, API keeps mark_as_read=false", () => {
  const page = readFileSync("app/central-reclamacoes/case-grid.tsx", "utf8"), detail = readFileSync("lib/marketplace-case-detail.ts", "utf8");
  assert.match(page, /<ClaimControls id=\{id\} data=\{data\} mode="chat"/);
  assert.match(page, /<PriorChatHistory messages=\{data.priorMessages/);
  assert.doesNotMatch(detail, /getMercadoLivre|recoverClaimChatHistory/);
  assert.match(readFileSync("lib/mercado-livre.ts", "utf8"), /mark_as_read: "false"/);
});
