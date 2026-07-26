import crypto from "node:crypto";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const dryRun = process.argv.includes("--dry-run");
const days = 30;
const partnerId = String(process.env.SHOPEE_PARTNER_ID || "2038366");
const defaultPartnerKey = String(process.env.SHOPEE_PARTNER_KEY || "");
const baseUrl = String(process.env.SHOPEE_API_BASE_URL || "https://partner.shopeemobile.com").replace(/\/+$/, "");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const { data: accounts, error: accountsError } = await db
  .from("config_marketplace_accounts")
  .select("id,name,nickname,shop_id,account_id,client_id,client_secret,access_token,refresh_token,token_expires_at,status")
  .eq("marketplace", "shopee")
  .eq("active", true);
if (accountsError) throw accountsError;

const summary = { dryRun, periodDays: days, accounts: [], found: 0, inserted: 0, updated: 0, failed: 0, failures: [] };

for (const account of accounts || []) {
  const shopId = String(account.shop_id || account.account_id || "");
  const partnerKey = String(account.client_secret || defaultPartnerKey);
  if (!shopId || !partnerKey) {
    summary.failed++;
    summary.failures.push({ account: account.name, error: "shop_id ou Partner Key ausente" });
    continue;
  }

  try {
    const accessToken = await validAccessToken(account, shopId, partnerKey);
    const refs = await listOrders(accessToken, shopId, partnerKey);
    summary.accounts.push({ name: account.name, shopId, orders: refs.length, statuses: groupBy(refs, "order_status") });
    summary.found += refs.length;

    if (dryRun) continue;

    for (const batch of chunks(refs, 50)) {
      const details = await signedRequest("/api/v2/order/get_order_detail", {
        accessToken, shopId, partnerKey,
        query: {
          order_sn_list: batch.map((order) => order.order_sn).join(","),
          response_optional_fields: [
            "buyer_user_id", "buyer_username", "estimated_shipping_fee", "recipient_address",
            "actual_shipping_fee", "item_list", "pay_time", "cancel_by", "cancel_reason",
            "package_list", "shipping_carrier", "payment_method", "total_amount"
          ].join(",")
        }
      });
      for (const order of details.response?.order_list || []) {
        try {
          const outcome = await saveOrder(account, shopId, order);
          summary[outcome]++;
        } catch (error) {
          summary.failed++;
          summary.failures.push({ orderSn: String(order.order_sn || ""), error: message(error) });
        }
      }
    }
  } catch (error) {
    summary.failed++;
    summary.failures.push({ account: account.name, error: message(error) });
  }
}

console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;

async function listOrders(accessToken, shopId, partnerKey) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 24 * 60 * 60;
  const windows = [];
  for (let start = since; start < until; start += 14 * 24 * 60 * 60) {
    windows.push([start, Math.min(until, start + 14 * 24 * 60 * 60 - 1)]);
  }
  const orders = new Map();
  for (const [timeFrom, timeTo] of windows) {
    let cursor = "";
    do {
      const response = await signedRequest("/api/v2/order/get_order_list", {
        accessToken, shopId, partnerKey,
        query: {
          time_range_field: "create_time",
          time_from: timeFrom,
          time_to: timeTo,
          page_size: 100,
          cursor
        }
      });
      for (const order of response.response?.order_list || []) {
        if (order.order_sn) orders.set(String(order.order_sn), order);
      }
      cursor = response.response?.more ? String(response.response?.next_cursor || "") : "";
    } while (cursor);
  }
  return [...orders.values()];
}

async function validAccessToken(account, shopId, partnerKey) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expiresAt > Date.now() + 60_000) return String(account.access_token);
  if (!account.refresh_token) throw new Error(`Conta ${account.name} sem refresh_token.`);

  const token = await signedRequest("/api/v2/auth/access_token/get", {
    partnerKey,
    method: "POST",
    body: { refresh_token: account.refresh_token, shop_id: Number(shopId), partner_id: Number(partnerId) }
  });
  if (!token.access_token) throw new Error(`Refresh Shopee falhou: ${String(token.message || token.error || "sem token")}`);
  const expiresIn = Number(token.expire_in || 0);
  const { error } = await db.from("config_marketplace_accounts").update({
    access_token: token.access_token,
    refresh_token: token.refresh_token || account.refresh_token,
    token_expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    status: "active",
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq("id", account.id);
  if (error) throw error;
  return String(token.access_token);
}

async function signedRequest(path, options) {
  const timestamp = Math.floor(Date.now() / 1000);
  const base = options.accessToken && options.shopId
    ? `${partnerId}${path}${timestamp}${options.accessToken}${options.shopId}`
    : `${partnerId}${path}${timestamp}`;
  const sign = crypto.createHmac("sha256", options.partnerKey).update(base).digest("hex");
  const params = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign });
  if (options.accessToken) params.set("access_token", String(options.accessToken));
  if (options.shopId) params.set("shop_id", String(options.shopId));
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const response = await fetch(`${baseUrl}${path}?${params}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.method === "POST" ? JSON.stringify(options.body || {}) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) throw new Error(`Shopee ${path}: ${JSON.stringify(json)}`);
  return json;
}

async function saveOrder(account, shopId, order) {
  const orderSn = String(order.order_sn || "");
  const eventId = `recovery:shopee:${shopId}:${orderSn}`;
  const { data: existingSale } = await db.from("venda").select("id").eq("marketplace", "shopee").eq("order_id", orderSn).maybeSingle();
  const { data: statusRow } = await db.from("status_venda").select("id").eq("marketplace", "shopee")
    .eq("external_status", String(order.order_status || "unknown")).maybeSingle();
  const items = Array.isArray(order.item_list) ? order.item_list : [];
  const productValue = number(order.total_amount)
    || items.reduce((total, item) => total + number(item.model_discounted_price || item.discounted_price) * number(item.model_quantity_purchased || 1), 0);
  const shipping = number(order.actual_shipping_fee);
  const rawPayload = { recovery: true, shop_id: shopId, order };

  const { data: savedSale, error: saleError } = await db.from("venda").upsert({
    marketplace: "shopee",
    order_id: orderSn,
    status_id: statusRow?.id || null,
    status_original: String(order.order_status || "unknown"),
    valor_produtos: productValue,
    valor_frete: shipping,
    valor_liquido: productValue + shipping,
    data_venda: epochDate(order.create_time),
    shipment_id: String(order.package_list?.[0]?.package_number || ""),
    raw_data: {
      payload: rawPayload,
      marketplace_account_id: account.id,
      marketplace_nickname: account.nickname || account.name
    },
    updated_at: new Date().toISOString()
  }, { onConflict: "marketplace,order_id" }).select("id").single();
  if (saleError) throw saleError;

  for (const item of items) {
    const sku = String(item.model_sku || item.item_sku || "").trim();
    if (!sku) continue;
    const quantity = Math.max(1, number(item.model_quantity_purchased || 1));
    const unitPrice = number(item.model_discounted_price || item.discounted_price);
    const { error } = await db.from("venda_item").upsert({
      venda_id: savedSale.id, order_id: orderSn, sku, quantidade: quantity,
      valor_unitario: unitPrice, valor_total: unitPrice * quantity, raw_data: { order_item: item }
    }, { onConflict: "venda_id,sku" });
    if (error) throw error;
  }

  const { data: existingActivity } = await db.from("marketplace_activities").select("id")
    .eq("marketplace", "shopee").eq("external_event_id", eventId).maybeSingle();
  const activity = {
    marketplace: "shopee", event_type: "historical_order_recovery", external_event_id: eventId,
    order_id: orderSn, venda_id: savedSale.id, description: `Pedido Shopee recuperado: ${String(order.order_status || "unknown")}`,
    value: productValue, item_count: items.reduce((total, item) => total + Math.max(1, number(item.model_quantity_purchased || 1)), 0),
    status: "processed", raw_payload: rawPayload, processing_error: null,
    processed_at: new Date().toISOString(), received_at: epochDate(order.update_time || order.create_time)
  };
  const activityQuery = existingActivity?.id
    ? db.from("marketplace_activities").update(activity).eq("id", existingActivity.id)
    : db.from("marketplace_activities").insert(activity);
  const { error: activityError } = await activityQuery;
  if (activityError) throw activityError;
  return existingSale?.id ? "updated" : "inserted";
}

function epochDate(value) {
  const numberValue = number(value);
  return numberValue > 0 ? new Date(numberValue * 1000).toISOString() : new Date().toISOString();
}
function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}
function groupBy(rows, key) {
  return rows.reduce((result, row) => {
    const value = String(row[key] || "unknown");
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
