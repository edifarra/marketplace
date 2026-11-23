import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

// Reject recovery before loading credentials, refreshing tokens or reading APIs.
if (process.argv.includes("--recover")) throw new Error("Recuperação histórica bloqueada pela GMUD 1.");
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const until = new Date();
const recover = process.argv.includes("--recover");
const { data: accounts, error } = await db.from("config_marketplace_accounts")
  .select("id,name,nickname,seller_id,account_id,access_token,refresh_token,token_expires_at,client_id,client_secret")
  .eq("marketplace", "mercado_livre").eq("active", true);
if (error) throw error;

const sourceOrders = new Map();
const accountSummaries = [];
for (const account of accounts || []) {
  const token = await validToken(account);
  const seller = String(account.seller_id || account.account_id || "");
  let offset = 0;
  let total = 0;
  do {
    const params = new URLSearchParams({
      seller,
      sort: "date_desc",
      limit: "50",
      offset: String(offset),
      "order.date_created.from": since.toISOString(),
      "order.date_created.to": until.toISOString()
    });
    const response = await fetch(`https://api.mercadolibre.com/orders/search?${params}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Mercado Livre ${account.name}: ${response.status} ${JSON.stringify(json)}`);
    for (const order of json.results || []) sourceOrders.set(String(order.id), { account, token, status: order.status });
    total = Number(json.paging?.total || 0);
    offset += (json.results || []).length;
  } while (offset < total && offset > 0);
  accountSummaries.push({ account: account.name, orders: total });
}

const { data: saved, error: savedError } = await db.from("venda").select("order_id")
  .eq("marketplace", "mercado_livre").in("order_id", [...sourceOrders.keys()]);
if (savedError) throw savedError;
const savedIds = new Set((saved || []).map((sale) => String(sale.order_id)));
const sourceIds = new Set(sourceOrders.keys());
console.log(JSON.stringify({
  period: { since: since.toISOString(), until: until.toISOString() },
  accounts: accountSummaries,
  sourceOrders: sourceIds.size,
  savedOrders: savedIds.size,
  missingInSystem: [...sourceIds].filter((id) => !savedIds.has(id)),
  noLongerInSource: [...savedIds].filter((id) => !sourceIds.has(id))
}, null, 2));

if (recover) {
  const missing = [...sourceIds].filter((id) => !savedIds.has(id));
  const recovery = { requested: missing.length, inserted: 0, failed: 0, failures: [] };
  for (const orderId of missing) {
    try {
      const source = sourceOrders.get(orderId);
      await saveOrder(orderId, source.account, source.token);
      recovery.inserted++;
    } catch (recoveryError) {
      recovery.failed++;
      recovery.failures.push({ orderId, error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) });
    }
  }
  console.log(JSON.stringify({ recovery }, null, 2));
  if (recovery.failed) process.exitCode = 1;
}

async function saveOrder() {
  throw new Error("Recuperação histórica bloqueada: requer conciliação financeira e aprovação específica.");
}

async function mlGet(path, token, newFormat = false) {
  const response = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { authorization: `Bearer ${token}`, ...(newFormat ? { "x-format-new": "true" } : {}) }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function validToken(account) {
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expires > Date.now() + 60_000) return account.access_token;
  if (!account.refresh_token || !account.client_id || !account.client_secret) {
    if (account.access_token) return account.access_token;
    throw new Error(`Conta ${account.name} sem token OAuth.`);
  }
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: account.client_id,
      client_secret: account.client_secret, refresh_token: account.refresh_token
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Refresh Mercado Livre ${account.name}: ${response.status}`);
  const { error: updateError } = await db.from("config_marketplace_accounts").update({
    access_token: json.access_token,
    refresh_token: json.refresh_token || account.refresh_token,
    token_expires_at: new Date(Date.now() + Number(json.expires_in || 0) * 1000).toISOString(),
    seller_id: String(json.user_id || account.seller_id || account.account_id || ""),
    updated_at: new Date().toISOString()
  }).eq("id", account.id);
  if (updateError) throw updateError;
  return json.access_token;
}
