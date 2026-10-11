import assert from "node:assert/strict";
import test from "node:test";
import { reconcileMercadoLivrePostSaleConversationPath } from "../lib/marketplace-conversations";

test("persists conversation without order after 404, recovers imported order, retains link and avoids repeated remote requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  const pack = "2000018835267074", accountId = "persistence-account";
  let imported = false, packsRequested = 0, conversationsRequested = 0;
  let stored: Record<string, any> | null = null;
  const messages: Record<string, any>[] = [];
  const remote = { conversation_status: { path: `/packs/${pack}/sellers/111`, status: "active" }, messages: [{
    id: "m1", from: { user_id: "222" }, to: { user_id: "111" }, text: "original message",
    message_date: { created: "2026-01-01T10:00:00Z" }, message_resources: [{ name: "packs", id: pack }]
  }] };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "api.mercadolibre.com") {
        if (url.pathname.startsWith("/packs/")) { packsRequested++; return json({ error: "pack_not_found" }, 404); }
        assert.equal(url.pathname, `/messages/packs/${pack}/sellers/111`);
        assert.equal(url.searchParams.get("mark_as_read"), "false");
        conversationsRequested++;
        return json(remote);
      }
      assert.equal(url.hostname, "test.supabase.co");
      const table = url.pathname.split("/").at(-1);
      const method = init?.method || "GET";
      if (table === "venda") {
        assert.ok(!url.searchParams.get("select")?.split(",").includes("pack_id"), "nonexistent venda.pack_id queried");
        if (url.searchParams.get("select") === "order_id") {
          assert.equal(url.searchParams.get("raw_data->>marketplace_account_id"), `eq.${accountId}`);
          const exact = !!url.searchParams.get("order_id");
          return json(imported && exact ? [{ order_id: pack }] : []);
        }
        return json([]); // No product enrichment in this fixture.
      }
      if (table === "marketplace_conversations") {
        if (method === "GET") return json(stored ? [stored] : []);
        assert.equal(method, "POST");
        stored = { id: "c1", ...stored, ...JSON.parse(String(init?.body)) };
        return json(stored);
      }
      assert.equal(table, "marketplace_conversation_messages");
      if (method === "GET") return json(messages);
      const body = JSON.parse(String(init?.body));
      if (method === "POST") messages.push({ id: "msg1", ...body });
      else assert.fail(`unexpected message mutation ${method}`);
      return json([]);
    };
    const account = { id: accountId, name: "ML-ED", seller_id: "111", account_id: "111", marketplace: "mercado_livre", active: true, access_token: "test-token" } as any;
    const run = () => reconcileMercadoLivrePostSaleConversationPath(account, `/packs/${pack}/sellers/111`);
    const first = await run();
    assert.equal(first.order_id, null);
    assert.equal(first.pack_id, pack);
    assert.equal(messages.length, 1);
    const history = structuredClone(messages);
    const second = await run();
    assert.equal(second.order_id, null);
    assert.equal(packsRequested, 1);
    imported = true;
    const recovered = await run();
    assert.equal(recovered.order_id, pack);
    assert.equal(recovered.status, first.status);
    assert.deepEqual(messages, history);
    imported = false;
    assert.equal((await run()).order_id, pack);
    assert.equal(packsRequested, 1);
    assert.equal(conversationsRequested, 4, "one conversation read per reconciliation, no duplicate detail request");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
