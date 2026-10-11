// Production reads only. Stored token, no OAuth refresh, RPC, persistence or queue writes.
import assert from "node:assert/strict";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recoverClaimChatHistory, priorClaimChatMessages } from "../lib/marketplace-claim-chat-history";
import { normalizeMercadoLivrePostSale } from "../lib/mercado-livre-post-sale";
import { mercadoLivreAttachments } from "../lib/marketplace-special-messages";

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  assert.ok([new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host, "api.mercadolibre.com"].includes(url.host));
  assert.ok(["GET", "HEAD"].includes(init?.method || (input instanceof Request ? input.method : "GET")), "Read-only validation blocked mutation");
  return originalFetch(input, init);
};
async function main() {
  const db = supabaseAdmin();
  const row = (await db.from("marketplace_cases").select("marketplace_account_id,order_id,content").eq("marketplace", "mercado_livre").eq("external_case_id", "5592119231").single().throwOnError()).data;
  const account = (await db.from("config_marketplace_accounts").select("id,seller_id,account_id,access_token").eq("id", row.marketplace_account_id).eq("marketplace", "mercado_livre").single().throwOnError()).data;
  const read = async (path: string) => {
    const response = await fetch(`https://api.mercadolibre.com${path}`, { headers: { authorization: `Bearer ${account.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Object.assign(new Error(`Official read failed: HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
  const order = await read(`/orders/${row.order_id}`);
  let normalized: ReturnType<typeof normalizeMercadoLivrePostSale> = [];
  const outcome = await recoverClaimChatHistory(account, order, row.content.claim_created_at, {
    acquire: async () => true, finish: async () => {},
    read: path => read(`/messages${path}?tag=post_sale&mark_as_read=false`),
    // Deliberately normalize in memory instead of writing to production.
    persist: async remote => { normalized = normalizeMercadoLivrePostSale(remote, String(account.seller_id || account.account_id), account.id); }
  });
  assert.equal(outcome, "success"); assert.equal(normalized.length, 6);
  const prior = priorClaimChatMessages(normalized.map(m => ({ id: m.messageId, external_message_id: m.messageId, sent_at: m.sentAt })), row.content.claim_created_at);
  assert.equal(prior.length, 6);
  console.log(JSON.stringify({ claim: "5592119231", order: row.order_id, count: normalized.length, messages: normalized.map(m => ({ direction: m.direction, at: m.sentAt, emptyText: !m.text, attachments: mercadoLivreAttachments(m.raw).map(a => ({ mimeType: a.mimeType, isImage: a.isImage })) })) }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => { globalThis.fetch = originalFetch; });
