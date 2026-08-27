import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "crypto";
import { supabaseAdmin } from "./supabase-admin";
import { salePostedAt } from "./sales-fulfillment";
import { getMercadoLivreAccountById, getMercadoLivreShipment } from "./mercado-livre";
import { getActiveShopeeAccounts } from "./shopee";

type Config = { enabled: boolean; bot_token_encrypted: string | null; chat_id: string | null; recipient_name: string | null; timezone: string; new_sale_enabled: boolean; new_sale_start: string; new_sale_end: string; dispatch_enabled: boolean; dispatch_check_time: string };
type Sale = { id: string; marketplace: string; order_id: string; status_original: string | null; data_venda: string | null; created_at: string; shipment_id: string | null; raw_data: Record<string, any>; status_venda?: { final_status?: boolean } | null };

export async function getTelegramConfig() {
  const { data, error } = await supabaseAdmin().from("telegram_notification_config").select("*").eq("id", true).single();
  if (error) throw new Error(error.message);
  return data as Config;
}

export async function saveTelegramConfig(input: Record<string, unknown>, userId: string) {
  const current = await getTelegramConfig();
  const token = String(input.botToken || "").trim();
  const update = {
    enabled: Boolean(input.enabled), chat_id: nullable(input.chatId), recipient_name: nullable(input.recipientName),
    timezone: String(input.timezone || "America/Sao_Paulo"), new_sale_enabled: Boolean(input.newSaleEnabled),
    new_sale_start: validTime(input.newSaleStart, "11:50"), new_sale_end: validTime(input.newSaleEnd, "13:00"),
    dispatch_enabled: Boolean(input.dispatchEnabled), dispatch_check_time: validTime(input.dispatchCheckTime, "16:30"),
    bot_token_encrypted: token ? encrypt(token) : current.bot_token_encrypted, updated_at: new Date().toISOString(), updated_by: userId
  };
  const { error } = await supabaseAdmin().from("telegram_notification_config").update(update).eq("id", true);
  if (error) throw new Error(error.message);
}

export async function testTelegram() {
  const config = await getTelegramConfig();
  return sendAndRecord(config, "Teste de notificação — Gestão Marketplace .Tech", { alertType: "test", key: `test:${randomUUID()}` });
}

export async function notifyNewSale(saleId: string) {
  try {
    const config = await getTelegramConfig();
    if (!config.enabled || !config.new_sale_enabled || !insideWindow(new Date(), config.timezone, config.new_sale_start, config.new_sale_end)) return;
    const sale = await loadSale(saleId);
    if (!sale || !isRealSale(sale)) return;
    const items = await loadItems(saleId);
    const account = String(sale.raw_data?.marketplace_nickname || "Não informada");
    const lines = ["🛒 NOVA VENDA", "", `Marketplace: ${marketplaceName(sale.marketplace)}`, `Conta: ${account}`, `Pedido: ${sale.order_id}`, `Horário: ${localTime(new Date(), config.timezone)}`, ""];
    for (const item of items) lines.push(`Produto: ${item.title || "Não informado"}`, `SKU: ${item.sku}`, `Quantidade: ${item.quantidade}`, "");
    await sendAndRecord(config, lines.join("\n").trim(), { alertType: "new_sale", key: `new_sale:${sale.marketplace}:${sale.order_id}`, sale, account });
  } catch (error) {
    // Telegram nunca pode interromper o processamento da venda, mas a falha
    // precisa ficar visivel nos logs para nao desaparecer sem diagnostico.
    console.error("[telegram_new_sale]", { saleId, error: safeError(error) });
  }
}

export async function runPendingDispatchJob(now = new Date()) {
  const config = await getTelegramConfig();
  if (!config.enabled || !config.dispatch_enabled) return { skipped: "disabled" };
  const date = localDate(now, config.timezone);
  if (localTime(now, config.timezone) < config.dispatch_check_time.slice(0, 5)) return { skipped: "not_due" };
  const claim = await supabaseAdmin().from("telegram_notification_jobs").insert({ job_name: "pending_dispatch", run_date: date, status: "running" });
  if (claim.error?.code === "23505") return { skipped: "already_run" };
  if (claim.error) throw new Error(claim.error.message);
  try {
    const start = new Date(`${date}T00:00:00-03:00`).toISOString();
    const end = new Date(`${date}T23:59:59.999-03:00`).toISOString();
    const result = await supabaseAdmin().from("venda").select("id,marketplace,order_id,status_original,data_venda,created_at,shipment_id,raw_data,status_venda(final_status)")
      .gte("data_venda", start).lte("data_venda", end).not("raw_data->>marketplace_label_printed_at", "is", null);
    if (result.error) throw new Error(result.error.message);
    const pending: Array<{ sale: Sale; items: any[]; account: string }> = [];
    for (const original of (result.data || []) as unknown as Sale[]) {
      if (original.status_venda?.final_status) continue;
      await refreshSale(original).catch(() => undefined);
      const sale = await loadSale(original.id);
      if (!sale || sale.status_venda?.final_status || salePostedAt(sale)) continue;
      pending.push({ sale, items: await loadItems(sale.id), account: String(sale.raw_data?.marketplace_nickname || "Não informada") });
    }
    if (pending.length) {
      const lines = ["🚨 PEDIDOS AGUARDANDO DESPACHO", "", `Existem ${pending.length} venda(s) com etiqueta impressa que ainda não constam como despachadas.`, ""];
      pending.forEach((entry, index) => lines.push(`${index + 1}. ${entry.account} — Pedido ${entry.sale.order_id}`, `SKU: ${entry.items.map((item) => item.sku).join(", ") || "Não informado"}`, ""));
      lines.push(`⏰ Verificação: ${localTime(now, config.timezone)}`);
      await sendAndRecord(config, lines.join("\n"), { alertType: "pending_dispatch", key: `pending_dispatch:${date}`, account: "Consolidado" });
    }
    await supabaseAdmin().from("telegram_notification_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("job_name", "pending_dispatch").eq("run_date", date);
    return { pending: pending.length };
  } catch (error) {
    const message = safeError(error);
    await supabaseAdmin().from("telegram_notification_jobs").update({ status: "error", completed_at: new Date().toISOString(), error_message: message }).eq("job_name", "pending_dispatch").eq("run_date", date);
    throw error;
  }
}

async function refreshSale(sale: Sale) {
  const accountId = String(sale.raw_data?.marketplace_account_id || "");
  if (sale.marketplace === "mercado_livre" && sale.shipment_id && accountId) {
    const shipment = await getMercadoLivreShipment(sale.shipment_id, await getMercadoLivreAccountById(accountId));
    if (salePostedAt({ ...sale, raw_data: { ...sale.raw_data, payload: { ...(sale.raw_data.payload || {}), shipment } } })) {
      await supabaseAdmin().from("venda").update({ raw_data: { ...sale.raw_data, marketplace_posted_at: new Date().toISOString(), payload: { ...(sale.raw_data.payload || {}), shipment } } }).eq("id", sale.id);
    }
  } else if (sale.marketplace === "shopee") {
    const account = (await getActiveShopeeAccounts()).find((item) => item.id === accountId);
    if (account) {
      const { processShopeeOrder } = await import("./shopee-orders");
      await processShopeeOrder(sale.order_id, account, { reconciliation: "telegram_dispatch_check" });
    }
  }
}

async function sendAndRecord(config: Config, text: string, meta: { alertType: "test" | "new_sale" | "pending_dispatch"; key: string; sale?: Sale; account?: string }) {
  const db = supabaseAdmin();
  const base = { alert_type: meta.alertType, sale_id: meta.sale?.id || null, order_id: meta.sale?.order_id || null, marketplace: meta.sale?.marketplace || null, account_name: meta.account || null, notification_date: localDate(new Date(), config.timezone), idempotency_key: meta.key };
  const reserved = await db.from("telegram_notification_history").insert({ ...base, status: "ignored" }).select("id").single();
  if (reserved.error?.code === "23505") return { duplicated: true };
  if (reserved.error) throw new Error(reserved.error.message);
  try {
    if (!config.chat_id || !config.bot_token_encrypted) throw new Error("Bot Token e Chat ID são obrigatórios.");
    const response = await fetch(`https://api.telegram.org/bot${decrypt(config.bot_token_encrypted)}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: config.chat_id, text }), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(String(body.description || `Telegram HTTP ${response.status}`));
    await db.from("telegram_notification_history").update({ status: "sent", telegram_message_id: String(body.result?.message_id || "") }).eq("id", reserved.data.id);
    return { sent: true };
  } catch (error) {
    const message = safeError(error);
    await db.from("telegram_notification_history").update({ status: "error", error_message: message }).eq("id", reserved.data.id);
    throw new Error(message);
  }
}

async function loadSale(id: string) { const { data } = await supabaseAdmin().from("venda").select("id,marketplace,order_id,status_original,data_venda,created_at,shipment_id,raw_data,status_venda(final_status)").eq("id", id).maybeSingle(); return data as unknown as Sale | null; }
async function loadItems(id: string) {
  const { data } = await supabaseAdmin().from("venda_item").select("sku,quantidade,raw_data").eq("venda_id", id);
  return (data || []).map((item: any) => {
    const sourceItems = item.raw_data?.order?.order_items || item.raw_data?.order?.item_list || item.raw_data?.items || [];
    const source = sourceItems.find((candidate: any) => String(candidate.item?.seller_sku || candidate.model_sku || candidate.item_sku || candidate.sku || "") === String(item.sku)) || sourceItems[0] || {};
    return { ...item, title: source.item?.title || source.item_name || source.model_name || "" };
  });
}
function isRealSale(sale: Sale) { return !/cancel|refund|unpaid|payment_required/i.test(String(sale.status_original || "")); }
function nullable(value: unknown) { const text = String(value || "").trim(); return text || null; }
function validTime(value: unknown, fallback: string) { const text = String(value || ""); return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback; }
function localParts(date: Date, zone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).reduce((out, item) => ({ ...out, [item.type]: item.value }), {} as Record<string, string>); }
function localDate(date: Date, zone: string) { const p = localParts(date, zone); return `${p.year}-${p.month}-${p.day}`; }
function localTime(date: Date, zone: string) { const p = localParts(date, zone); return `${p.hour}:${p.minute}`; }
function insideWindow(date: Date, zone: string, start: string, end: string) { const time = localTime(date, zone); return time >= start.slice(0, 5) && time <= end.slice(0, 5); }
function marketplaceName(value: string) { return value === "mercado_livre" ? "Mercado Livre" : value === "shopee" ? "Shopee" : value; }
function key() { const secret = process.env.TELEGRAM_ENCRYPTION_KEY || process.env.AUTH_SESSION_SECRET; if (!secret) throw new Error("TELEGRAM_ENCRYPTION_KEY não configurada."); return createHash("sha256").update(secret).digest(); }
function encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join("."); }
function decrypt(value: string) { const [, iv, tag, encrypted] = value.split("."); const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]").slice(0, 1000); }
