import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import {
  marketplaceConversationChanged,
  planMarketplaceMessageWrites
} from "../lib/marketplace-message-reconciliation.ts";
import {
  loadUniqueValuesInChunks,
  mapShopeeConversationSnapshots,
  shopeeProductLookupNeeded,
  shopeeSnapshotKey,
  SHOPEE_CONVERSATION_SNAPSHOT_FIELDS,
  SHOPEE_CONVERSATION_SNAPSHOT_SELECT,
  SHOPEE_POSTGREST_IN_CHUNK_SIZE,
  SHOPEE_PRODUCT_LOOKUP_SELECT,
  uniqueShopeeCandidates
} from "../lib/shopee-conversation-reconciliation.ts";

const DEFAULT_SHOPEE_BASE_URL = "https://partner.shopeemobile.com";
const { loadEnvConfig } = nextEnv;
const CONVERSATION_FIELDS = [
  "external_status", "status", "requires_response", "unread", "buyer_id", "buyer_name", "product_id",
  "listing_id", "order_id", "sku", "product_title", "product_price", "available_stock", "product_status",
  "product_image_url", "purchased_at", "last_incoming_at", "last_outgoing_at", "last_message_at",
  "last_message_preview", "last_error", "pack_id", "seller_id", "conversation_path", "counterparty_id",
  "messaging_agent", "reviewed_at"
];
const MESSAGE_FIELDS = [
  "conversation_id", "external_message_id", "direction", "message_type", "text", "sender_id", "sender_name",
  "sent_at", "status", "marketplace_account_id", "external_message_key"
];

export function createReadonlyFetchGuard(fetchImplementation, allowedOrigins, counters = {}) {
  if (typeof fetchImplementation !== "function") throw new Error("fetch indisponível para validação read-only.");
  const origins = new Set([...allowedOrigins].map(value => new URL(value).origin));
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const method = String(init.method || request?.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error(`READ_ONLY_GUARD: método ${method} bloqueado.`);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!origins.has(url.origin)) throw new Error(`READ_ONLY_GUARD: origem não autorizada ${url.origin}.`);
    counters.total = (counters.total || 0) + 1;
    if (url.hostname.endsWith("supabase.co")) counters.supabase = (counters.supabase || 0) + 1;
    if (url.pathname.includes("/api/v2/")) counters.shopee = (counters.shopee || 0) + 1;
    return fetchImplementation(input, { ...init, method });
  };
}

export function maskId(value) {
  if (!value) return null;
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 10)}`;
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/access_token=[^&\s]+/gi, "access_token=[REDACTED]")
    .replace(/authorization:\s*[^,}\s]+/gi, "authorization:[REDACTED]")
    .slice(0, 500);
}

export function validateSnapshotRows(rows, accountId, requestedIds) {
  const requested = new Set(requestedIds);
  const issues = [];
  const seen = new Set();
  for (const row of rows) {
    const externalId = String(row.external_conversation_id || "");
    const key = shopeeSnapshotKey(String(row.marketplace_account_id || ""), externalId);
    if (String(row.marketplace_account_id || "") !== accountId) issues.push("snapshot_wrong_account");
    if (!requested.has(externalId)) issues.push("snapshot_unrequested_conversation");
    if (seen.has(key)) issues.push("snapshot_duplicate_identity");
    seen.add(key);
    for (const message of row.marketplace_conversation_messages || []) {
      if (!message.conversation_id) issues.push("message_missing_conversation_id");
      if (String(message.conversation_id || "") !== String(row.id || "")) issues.push("message_wrong_conversation_id");
      if (message.sent_at != null && Number.isNaN(new Date(String(message.sent_at)).getTime())) issues.push("message_invalid_timestamp");
      if (message.text != null && typeof message.text !== "string") issues.push("message_invalid_text_type");
    }
    for (const field of ["last_incoming_at", "last_outgoing_at", "last_message_at", "purchased_at", "reviewed_at"]) {
      if (row[field] != null && Number.isNaN(new Date(String(row[field])).getTime())) issues.push(`conversation_invalid_timestamp:${field}`);
    }
  }
  return { issues: [...new Set(issues)], identities: seen.size };
}

function shopeeDate(value) {
  const raw = value?.created_timestamp || value?.last_message_timestamp || value?.latest_message_timestamp
    || value?.create_time || value?.timestamp || value?.sent_at;
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    const parsed = new Date(String(raw));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const milliseconds = numeric > 1e15 ? Math.floor(numeric / 1e6) : numeric > 1e12 ? numeric : numeric * 1000;
  return new Date(milliseconds).toISOString();
}

function messageText(message) {
  const value = message?.text || message?.content?.text || message?.message || "";
  return typeof value === "string" ? value : "";
}

function isSellerMessage(message, account) {
  const shopId = String(account.shop_id || account.account_id || "");
  const source = String(message?.message_source || message?.sender_role || "").toLowerCase();
  return [message?.from_id, message?.from_shop_id, message?.sender_id]
    .some(value => value != null && String(value) === shopId) || ["seller", "shop", "merchant"].includes(source);
}

function compareMessages(left, right) {
  const byDate = (shopeeDate(left) || "").localeCompare(shopeeDate(right) || "");
  if (byDate) return byDate;
  const leftId = BigInt(String(left.message_id || left.id || "0").replace(/\D/g, "") || "0");
  const rightId = BigInt(String(right.message_id || right.id || "0").replace(/\D/g, "") || "0");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function messageWrite(conversationId, externalId, direction, text, senderId, senderName, sentAt, raw) {
  return {
    conversation_id: conversationId,
    external_message_id: externalId,
    direction,
    message_type: String(raw.message_type || raw.type || "text"),
    text,
    sender_id: senderId || null,
    sender_name: senderName || null,
    sent_at: sentAt,
    status: direction === "incoming" ? "received" : "sent",
    raw_data: raw,
    marketplace_account_id: null,
    external_message_key: null
  };
}

function buildRemotePlan(account, conversationId, seed, existing, detailPayload, messagePayload) {
  const detail = detailPayload?.response?.conversation || detailPayload?.response || seed;
  const response = messagePayload?.response;
  const messages = [...(response?.messages || response?.message_list || response?.message || [])].sort(compareMessages);
  const latest = messages[messages.length - 1] || detail.last_message || seed;
  const hasSender = Boolean(latest.from_id || latest.from_shop_id || latest.sender_id || latest.sender_role || latest.message_source);
  const incoming = hasSender ? !isSellerMessage(latest, account) : Number(detail.unread_count ?? seed.unread_count ?? 0) > 0;
  const itemId = String(latest.content?.item_id || latest.source_content?.item_id || latest.item_id
    || detail.item_id || seed.latest_message_content?.item_id || "");
  const orderSn = String(latest.content?.order_sn || latest.order_sn || detail.order_sn || "");
  const sentAt = shopeeDate(latest) || new Date().toISOString();
  const productIdentityChanged = Boolean(existing && (
    itemId && String(existing.listing_id || "") !== itemId
    || !itemId && orderSn && String(existing.order_id || "") !== orderSn
  ));
  const preservedProduct = existing && !productIdentityChanged ? {
    product_id: existing.product_id, sku: existing.sku, product_title: existing.product_title,
    product_price: existing.product_price, available_stock: existing.available_stock,
    product_status: existing.product_status, product_image_url: existing.product_image_url,
    purchased_at: existing.purchased_at
  } : productIdentityChanged ? {
    product_id: null, sku: null, product_title: null, product_price: null, available_stock: null,
    product_status: null, product_image_url: null, purchased_at: null
  } : {};
  const desired = {
    marketplace: "shopee", marketplace_account_id: account.id, external_conversation_id: conversationId,
    conversation_type: "chat", external_status: detail.status ? String(detail.status) : "NOT_INFORMED",
    status: incoming ? "pending" : "answered", requires_response: incoming, unread: incoming,
    buyer_id: String(detail.to_id || detail.peer_id || detail.buyer_id || latest.from_id || latest.sender_id || "") || null,
    buyer_name: String(detail.to_name || detail.peer_name || detail.buyer_username || "") || null,
    listing_id: itemId || null, order_id: orderSn || null, last_incoming_at: incoming ? sentAt : null,
    last_outgoing_at: incoming ? null : sentAt, last_message_at: sentAt,
    last_message_preview: messageText(latest).slice(0, 240), ...preservedProduct
  };
  const desiredMessages = messages.map(message => {
    const direction = isSellerMessage(message, account) ? "outgoing" : "incoming";
    const externalId = String(message.message_id || message.id
      || createHash("sha256").update(JSON.stringify(message)).digest("hex"));
    return messageWrite(String(existing?.id || ""), externalId, direction, messageText(message),
      String(message.from_id || message.sender_id || ""), direction === "outgoing" ? account.name
        : String(detail.to_name || detail.peer_name || ""), shopeeDate(message) || sentAt, message);
  });
  const plan = planMarketplaceMessageWrites(desiredMessages, existing?.marketplace_conversation_messages || []);
  return { desired, desiredMessages, plan, itemId, orderSn };
}

function changedConversationFields(existing, desired) {
  if (!existing) return ["new_conversation"];
  return CONVERSATION_FIELDS.filter(field => marketplaceConversationChanged(existing, { [field]: desired[field] }));
}

function changedMessageCategories(existingRows, updatedRows) {
  const byId = new Map(existingRows.map(row => [String(row.external_message_id || ""), row]));
  const categories = new Set();
  for (const desired of updatedRows) {
    const existing = byId.get(desired.external_message_id);
    if (!existing) continue;
    for (const field of MESSAGE_FIELDS) {
      const current = field === "sent_at" ? normalizeTimestamp(existing[field]) : existing[field] ?? null;
      const next = field === "sent_at" ? normalizeTimestamp(desired[field]) : desired[field] ?? null;
      if (stableValue(current) !== stableValue(next)) categories.add(field);
    }
    const existingRaw = {
      content: existing.raw_content, source_content: existing.raw_source_content,
      image_url: existing.raw_image_url, url: existing.raw_url,
      message_type: existing.raw_message_type, type: existing.raw_type
    };
    const desiredRaw = {
      content: desired.raw_data?.content, source_content: desired.raw_data?.source_content,
      image_url: desired.raw_data?.image_url, url: desired.raw_data?.url,
      message_type: desired.raw_data?.message_type, type: desired.raw_data?.type
    };
    if (stableValue(compact(existingRaw)) !== stableValue(compact(desiredRaw))) categories.add("canonical_raw_data");
  }
  return [...categories].sort();
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function signedShopeeGet(account, path, query = {}) {
  const partnerId = String(account.client_id || process.env.SHOPEE_PARTNER_ID || "");
  const partnerKey = String(account.client_secret || process.env.SHOPEE_PARTNER_KEY || "");
  const accessToken = String(account.access_token || "");
  const shopId = String(account.shop_id || account.account_id || "");
  if (!partnerId || !partnerKey || !accessToken || !shopId) throw new Error("Conta sem credenciais read-only completas.");
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", partnerKey)
    .update(`${partnerId}${path}${timestamp}${accessToken}${shopId}`).digest("hex");
  const params = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign: signature,
    access_token: accessToken, shop_id: shopId });
  for (const [key, value] of Object.entries(query)) if (value != null && value !== "") params.set(key, String(value));
  const baseUrl = String(account.api_base_url || process.env.SHOPEE_API_BASE_URL || DEFAULT_SHOPEE_BASE_URL).replace(/\/+$/, "");
  return fetch(`${baseUrl}${path}?${params}`, { method: "GET" }).then(async response => {
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) throw new Error(`Shopee ${path}: HTTP ${response.status}, código ${String(json.error || "unknown")}.`);
    return json;
  });
}

function approximateBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function runValidation() {
  loadEnvConfig(process.cwd());
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error("Variáveis Supabase ausentes no ambiente do worker.");
  const counters = { total: 0, supabase: 0, shopee: 0 };
  const shopeeOrigin = process.env.SHOPEE_API_BASE_URL || DEFAULT_SHOPEE_BASE_URL;
  globalThis.fetch = createReadonlyFetchGuard(globalThis.fetch, [supabaseUrl, shopeeOrigin], counters);
  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: globalThis.fetch }
  });
  const report = {
    readonly: true,
    projection: { conversationRawDataSelected: SHOPEE_CONVERSATION_SNAPSHOT_FIELDS.includes("raw_data"),
      messageConversationIdSelected: SHOPEE_CONVERSATION_SNAPSHOT_SELECT.includes("conversation_id"),
      chunkSize: SHOPEE_POSTGREST_IN_CHUNK_SIZE },
    totals: { accountsFound: 0, accountsVerified: 0, accountsSkippedExpiredToken: 0, candidatesFound: 0,
      snapshotsLoaded: 0, messagesReceived: 0, messagesUnchanged: 0, wouldInsert: 0, wouldUpdate: 0,
      conversationsWouldChange: 0, productLookupsNeeded: 0, productLookupsResolved: 0,
      productLookupErrors: 0, chunks: 0, supabaseRequests: 0, shopeeRequests: 0, approximatePayloadBytes: 0 },
    accounts: [], issues: [], limitations: []
  };
  const accountResult = await db.from("config_marketplace_accounts")
    .select("id,name,account_id,shop_id,access_token,token_expires_at,client_id,client_secret,api_base_url,status")
    .eq("marketplace", "shopee").eq("active", true).order("name").throwOnError();
  report.totals.approximatePayloadBytes += approximateBytes(accountResult.data || []);
  const accounts = accountResult.data || [];
  report.totals.accountsFound = accounts.length;

  for (const account of accounts) {
    const accountReport = { account: maskId(account.id), status: "verified", candidates: 0, snapshots: 0,
      messagesReceived: 0, unchanged: 0, wouldInsert: 0, wouldUpdate: 0, conversationsWouldChange: 0,
      productLookupsNeeded: 0, productLookupsResolved: 0, snapshotChunks: 0, productChunks: 0,
      changedConversationFields: {}, changedMessageCategories: [], issues: [] };
    const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
    if (!account.access_token || expiresAt <= Date.now() + 60_000) {
      accountReport.status = "skipped_expired_or_missing_token";
      report.totals.accountsSkippedExpiredToken += 1;
      report.limitations.push(`Conta ${accountReport.account}: token ausente/expirado; refresh foi deliberadamente bloqueado.`);
      report.accounts.push(accountReport);
      continue;
    }
    const shopId = String(account.shop_id || account.account_id || "");
    const list = await signedShopeeGet(account, "/api/v2/sellerchat/get_conversation_list", {
      direction: "older", type: "all", page_size: 50,
      next_timestamp_nano: (BigInt(Date.now()) * 1_000_000n).toString()
    });
    report.totals.approximatePayloadBytes += approximateBytes(list);
    const recent = list.response?.conversation_list || list.response?.conversations || list.response?.conversation || [];
    const recentIds = recent.map(item => String(item.conversation_id || item.id || "")).filter(Boolean);
    const light = recentIds.length ? await db.from("marketplace_conversations")
      .select("external_conversation_id,external_status,last_message_at")
      .eq("marketplace", "shopee").eq("marketplace_account_id", account.id)
      .in("external_conversation_id", recentIds).throwOnError() : { data: [] };
    report.totals.approximatePayloadBytes += approximateBytes(light.data || []);
    const localById = new Map((light.data || []).map(row => [String(row.external_conversation_id), row]));
    const recentCandidates = [];
    for (const item of recent) {
      const id = String(item.conversation_id || item.id || "");
      if (!id) continue;
      const local = localById.get(id);
      const remoteAt = shopeeDate(item.last_message || item) || "";
      const remoteStatus = String(item.status || item.conversation_status || "");
      const shouldSync = !local || Number(item.unread_count || 0) > 0
        || (remoteAt && remoteAt > String(local.last_message_at || ""))
        || (remoteStatus && remoteStatus !== String(local.external_status || ""));
      if (shouldSync) recentCandidates.push({ id, seed: item });
    }
    const pending = await db.from("marketplace_conversations")
      .select("id,external_conversation_id,raw_data,listing_id,order_id,product_id,last_message_at,last_reconciled_at")
      .eq("marketplace", "shopee").eq("marketplace_account_id", account.id).eq("conversation_type", "chat")
      .or("requires_response.eq.true,and(product_id.is.null,listing_id.not.is.null),and(product_id.is.null,order_id.not.is.null)")
      .order("last_reconciled_at", { ascending: true, nullsFirst: true }).order("last_message_at", { ascending: false })
      .limit(5).throwOnError();
    report.totals.approximatePayloadBytes += approximateBytes(pending.data || []);
    const selected = new Set(recentCandidates.map(candidate => candidate.id));
    const pendingCandidates = (pending.data || []).map(row => ({ id: String(row.external_conversation_id || ""), seed: row.raw_data || {} }))
      .filter(candidate => candidate.id && !selected.has(candidate.id));
    const candidates = uniqueShopeeCandidates([...recentCandidates, ...pendingCandidates]);
    const ids = candidates.map(candidate => candidate.id);
    accountReport.candidates = ids.length;
    report.totals.candidatesFound += ids.length;
    const snapshotChunks = Math.ceil(new Set(ids).size / SHOPEE_POSTGREST_IN_CHUNK_SIZE);
    accountReport.snapshotChunks = snapshotChunks;
    report.totals.chunks += snapshotChunks;
    const snapshotRows = await loadUniqueValuesInChunks(ids, async chunk => {
      const result = await db.from("marketplace_conversations").select(SHOPEE_CONVERSATION_SNAPSHOT_SELECT)
        .eq("marketplace", "shopee").eq("marketplace_account_id", account.id)
        .in("external_conversation_id", chunk).throwOnError();
      report.totals.approximatePayloadBytes += approximateBytes(result.data || []);
      return result.data || [];
    });
    const validation = validateSnapshotRows(snapshotRows, account.id, ids);
    accountReport.issues.push(...validation.issues);
    const snapshots = mapShopeeConversationSnapshots(snapshotRows);
    accountReport.snapshots = snapshotRows.length;
    report.totals.snapshotsLoaded += snapshotRows.length;
    const productItemIds = [];
    for (const candidate of candidates) {
      const existing = snapshots.get(shopeeSnapshotKey(account.id, candidate.id)) || null;
      const [detail, messages] = await Promise.all([
        signedShopeeGet(account, "/api/v2/sellerchat/get_one_conversation", { conversation_id: candidate.id }),
        signedShopeeGet(account, "/api/v2/sellerchat/get_message", { conversation_id: candidate.id, offset: 0, page_size: 50 })
      ]);
      report.totals.approximatePayloadBytes += approximateBytes(detail) + approximateBytes(messages);
      const remote = buildRemotePlan(account, candidate.id, candidate.seed, existing, detail, messages);
      accountReport.messagesReceived += remote.desiredMessages.length;
      accountReport.unchanged += remote.plan.unchanged.length;
      accountReport.wouldInsert += remote.plan.inserted.length;
      accountReport.wouldUpdate += remote.plan.updated.length;
      const conversationFields = changedConversationFields(existing, remote.desired);
      if (conversationFields.length) {
        accountReport.conversationsWouldChange += 1;
        for (const field of conversationFields) accountReport.changedConversationFields[field]
          = (accountReport.changedConversationFields[field] || 0) + 1;
      }
      for (const category of changedMessageCategories(existing?.marketplace_conversation_messages || [], remote.plan.updated)) {
        if (!accountReport.changedMessageCategories.includes(category)) accountReport.changedMessageCategories.push(category);
      }
      if (shopeeProductLookupNeeded(existing, remote.itemId)) productItemIds.push(remote.itemId);
    }
    const uniqueProductIds = [...new Set(productItemIds.filter(Boolean))];
    accountReport.productLookupsNeeded = uniqueProductIds.length;
    report.totals.productLookupsNeeded += uniqueProductIds.length;
    const productChunks = Math.ceil(uniqueProductIds.length / SHOPEE_POSTGREST_IN_CHUNK_SIZE);
    accountReport.productChunks = productChunks;
    report.totals.chunks += productChunks;
    try {
      const products = await loadUniqueValuesInChunks(uniqueProductIds, async chunk => {
        const result = await db.from("product_marketplaces").select(SHOPEE_PRODUCT_LOOKUP_SELECT)
          .eq("marketplace_account_id", account.id).in("marketplace_product_id", chunk).throwOnError();
        report.totals.approximatePayloadBytes += approximateBytes(result.data || []);
        return result.data || [];
      });
      accountReport.productLookupsResolved = products.length;
      report.totals.productLookupsResolved += products.length;
    } catch (error) {
      report.totals.productLookupErrors += 1;
      accountReport.issues.push(`product_lookup:${safeError(error)}`);
    }
    report.totals.messagesReceived += accountReport.messagesReceived;
    report.totals.messagesUnchanged += accountReport.unchanged;
    report.totals.wouldInsert += accountReport.wouldInsert;
    report.totals.wouldUpdate += accountReport.wouldUpdate;
    report.totals.conversationsWouldChange += accountReport.conversationsWouldChange;
    report.totals.accountsVerified += 1;
    report.accounts.push(accountReport);
  }
  report.totals.supabaseRequests = counters.supabase;
  report.totals.shopeeRequests = counters.shopee;
  report.issues = [...new Set(report.accounts.flatMap(account => account.issues))];
  return report;
}

async function main() {
  try {
    const report = await runValidation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.issues.length) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ readonly: true, fatalError: safeError(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
