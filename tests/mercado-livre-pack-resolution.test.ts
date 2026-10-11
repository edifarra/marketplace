import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createMercadoLivrePackCache, localMercadoLivreOrderForPack, resolveMercadoLivrePackOrder, linkMercadoLivreConversationOrder, ML_PACK_NOT_FOUND_TTL_MS, preserveMercadoLivreOrderLink } from "../lib/mercado-livre-pack-resolution";
import { mlGet } from "../lib/mercado-livre";

type Row = { order_id: string; marketplace: string; raw_data: Record<string, any> };
const sale = (order: string, account = "a", orderPack?: string, shipmentPack?: string): Row => ({
  order_id: order, marketplace: "mercado_livre", raw_data: { marketplace_account_id: account, payload: { order: { pack_id: orderPack }, shipment: { pack_id: shipmentPack } } }
});

// Exercise the real Supabase query builder and REST parameters. Unknown columns
// fail, as in production; mocks accepting arbitrary chains would miss this bug.
function fixture(rows: Row[]) {
  const urls: URL[] = [];
  const db = createClient("https://test.supabase.co", "test-key", { global: { fetch: async input => {
    const url = new URL(String(input));
    urls.push(url);
    const known = ["select", "limit", "marketplace", "order_id", "raw_data->>marketplace_account_id", "raw_data->payload->order->>pack_id", "raw_data->payload->shipment->>pack_id"];
    for (const key of url.searchParams.keys()) assert.ok(known.includes(key), `column venda.${key} does not exist`);
    assert.equal(url.searchParams.get("select"), "order_id");
    assert.ok(url.searchParams.get("raw_data->>marketplace_account_id"), "every branch must constrain the account");
    const data = rows.filter(row => [...url.searchParams].every(([key, expression]) => {
      if (["select", "limit"].includes(key)) return true;
      const value = key === "marketplace" ? row.marketplace : key === "order_id" ? row.order_id
        : key === "raw_data->>marketplace_account_id" ? row.raw_data.marketplace_account_id
        : key.includes("shipment") ? row.raw_data.payload.shipment.pack_id : row.raw_data.payload.order.pack_id;
      return expression.startsWith("in.(") ? expression.slice(4, -1).split(",").includes(String(value)) : String(value) === expression.slice(3);
    })).slice(0, Number(url.searchParams.get("limit"))).map(row => ({ order_id: row.order_id }));
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  } } });
  return { db, urls };
}

for (const [label, rows, pack, expected] of [
  ["pack equals order_id", [sale("p")], "p", "p"],
  ["different order via JSON order pack", [sale("o", "a", "p")], "p", "o"],
  ["shipment pack as a number", [sale("o", "a", undefined, 123 as any)], "123", "o"],
  ["missing pack", [sale("other")], "p", null],
  ["other account cannot match", [sale("p", "b"), sale("o", "b", "p")], "p", null],
  ["duplicate branches are one order", [sale("p", "a", "p", "p")], "p", "p"],
  ["multiple orders for pack", [sale("o1", "a", "p"), sale("o2", "a", undefined, "p")], "p", null],
  ["exact ID cannot hide another pack match", [sale("p"), sale("o", "a", "p")], "p", null]
] as const) {
  test(label, async () => {
    const { db, urls } = fixture([...rows]);
    const result = await localMercadoLivreOrderForPack(db, "a", pack);
    assert.equal(result.orderId, expected);
    assert.equal(result.ambiguous, label.startsWith("multiple") || label.startsWith("exact"));
    assert.equal(urls.length, 3);
  });
}

test("unique local match avoids remote; ambiguity avoids arbitrary remote selection", async () => {
  for (const local of [{ orderId: "o", ambiguous: false }, { orderId: null, ambiguous: true }]) {
    const result = await resolveMercadoLivrePackOrder("p", async () => { throw new Error("must not request"); }, async () => local, () => {}, "a");
    assert.equal(result, local.orderId);
  }
});

test("404 deduplication, expiration, account isolation, explicit reprocessing and local recovery", async () => {
  let time = 0, requests = 0, warnings = 0;
  const cache = createMercadoLivrePackCache(() => time);
  const rows: Row[] = [];
  const { db } = fixture(rows);
  const remote = async () => { requests++; throw Object.assign(new Error("pack_not_found"), { status: 404 }); };
  const run = (account = "a") => resolveMercadoLivrePackOrder("p", remote, ids => localMercadoLivreOrderForPack(db, account, "p", ids), () => { warnings++; }, account, cache);
  assert.deepEqual(await Promise.all([run(), run(), run()]), [null, null, null]);
  assert.equal(requests, 1);
  await run(); assert.equal(requests, 1);
  await run("b"); assert.equal(requests, 2);
  time = ML_PACK_NOT_FOUND_TTL_MS;
  await run(); assert.equal(requests, 3);
  cache.clear(); await run(); assert.equal(requests, 4);
  rows.push(sale("o", "a", "p"));
  assert.equal(await run(), "o"); assert.equal(requests, 4);
  assert.equal(warnings, 4);
});

test("non-404 auth, rate limiting, temporary and network failures propagate and are never cached", async () => {
  for (const status of [401, 403, 429, 503, undefined]) {
    let requests = 0;
    const error = Object.assign(new Error("temporary unavailable"), { status });
    const cache = createMercadoLivrePackCache();
    const run = () => resolveMercadoLivrePackOrder("p", async () => { requests++; throw error; }, async () => ({ orderId: null, ambiguous: false }), () => {}, "a", cache);
    await assert.rejects(run, candidate => candidate === error);
    await assert.rejects(run, candidate => candidate === error);
    assert.equal(requests, 2);
  }
});

test("remote single order works; multi-order pack and local ambiguity stay unresolved", async () => {
  for (const [ids, local, expected] of [
    [["o"], { orderId: null, ambiguous: false }, "o"],
    [["o1", "o2"], { orderId: null, ambiguous: false }, null],
    [[], { orderId: null, ambiguous: false }, null],
    [["o"], { orderId: null, ambiguous: true }, null]
  ] as const) {
    let calls = 0;
    const result = await resolveMercadoLivrePackOrder("p", async () => ({ orders: ids.map(id => ({ id })) }), async () => ++calls === 1 ? { orderId: null, ambiguous: false } : local, () => {}, "a", createMercadoLivrePackCache());
    assert.equal(result, expected);
  }
});

test("HTTP status survives malformed or absent API error body", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("not json", { status: 404 });
    await assert.rejects(() => mlGet("/packs/p", "token"), (error: any) => error.status === 404);
  } finally { globalThis.fetch = original; }
});

test("idempotent repair changes order_id alone and preserves status/messages/history", async () => {
  const conversation: Record<string, any> = { id: "c", marketplace: "mercado_livre", conversation_type: "post_sale", marketplace_account_id: "a", pack_id: "p", order_id: null, status: "answered", raw_data: { messages: [{ text: "original" }] } };
  const before = structuredClone(conversation);
  const db = createClient("https://test.supabase.co", "test-key", { global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "PATCH");
    assert.equal(url.searchParams.get("order_id"), "is.null");
    for (const key of ["id", "marketplace", "conversation_type", "marketplace_account_id", "pack_id"]) assert.equal(url.searchParams.get(key), `eq.${conversation[key]}`);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { order_id: "o" });
    const changed = !conversation.order_id;
    if (changed) Object.assign(conversation, body);
    return new Response(JSON.stringify(changed ? [conversation] : []), { headers: { "content-type": "application/json" } });
  } } });
  const key = { id: "c", marketplace_account_id: "a", pack_id: "p" };
  assert.equal((await linkMercadoLivreConversationOrder(db, key, "o")).data?.length, 1);
  assert.equal((await linkMercadoLivreConversationOrder(db, key, "o")).data?.length, 0);
  assert.deepEqual(conversation, { ...before, order_id: "o" });
  const incoming = { marketplace: "mercado_livre", conversation_type: "post_sale", order_id: null };
  assert.equal(preserveMercadoLivreOrderLink(incoming, conversation).order_id, "o");
});
