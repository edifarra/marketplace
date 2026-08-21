const fs = require("fs");
require("@next/env").loadEnvConfig(process.cwd());
const protectedEnvFile = fs.existsSync("tmp/.env.production") ? "tmp/.env.production" : ".env.vercel.local";
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && fs.existsSync(protectedEnvFile)) {
  for (const line of fs.readFileSync(protectedEnvFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
const { createClient } = require("@supabase/supabase-js");

async function runMarketplaceModerationAudit() {
  const sqlFile = process.env.AUDIT_SQL_FILE || "";
  const statements = [];
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, sqlFile ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - 30 * 86400000);
  const accounts = await allRows(db.from("config_marketplace_accounts").select("id,name,nickname,marketplace,seller_id,shop_id,access_token").eq("active", true));
  const links = await allRows(db.from("product_marketplaces").select("*").eq("existe_no_marketplace", true));
  const accountById = new Map(accounts.map(row => [row.id, row]));
  const summary = { mercadoLivre: { final: 0, review: 0, unlinked: 0 }, shopee: { final: 0, review: 0, unlinked: 0 }, recordsWithin30Days: 0 };

  for (const link of links.filter(row => row.marketplace === "mercado_livre")) {
    const stored = String(link.status_anuncio || link.raw_data?.status || "").toLowerCase();
    if (!["under_review", "closed", "inactive"].includes(stored)) continue;
    const account = accountById.get(link.marketplace_account_id); if (!account?.access_token) continue;
    const item = await apiJson(`https://api.mercadolibre.com/items/${link.marketplace_product_id}`, account.access_token);
    if (!item?.id) continue;
    const subs = Array.isArray(item.sub_status) ? item.sub_status.map(String) : [];
    const classification = ["closed", "inactive"].includes(String(item.status)) || subs.includes("forbidden") ? "final" : String(item.status) === "under_review" ? "review" : null;
    if (!classification) continue;
    const moderation = await apiJson(`https://api.mercadolibre.com/moderations/last_moderation/${item.id}-ITM`, account.access_token, []);
    const wordings = (Array.isArray(moderation) ? moderation : []).flatMap(row => row.wordings || []);
    const reason = wordings.find(row => row.type === "REASON")?.value || (classification === "final" ? "Anúncio encerrado pelo Mercado Livre." : "Anúncio em revisão pelo Mercado Livre.");
    const remedy = wordings.find(row => row.type === "REMEDY")?.value || null;
    const eventAt = new Date(moderation?.[0]?.date_created || item.last_updated || link.updated_at || Date.now());
    await applyModeration({ db, statements, sqlFile, link, account, marketplace: "mercado_livre", status: String(item.status), classification, reason, remedy, productName: item.title, eventAt, rawData: { ...item, moderation } }, cutoff, summary);
  }

  const shopeeActivities = await allRows(db.from("marketplace_activities").select("id,external_event_id,received_at,raw_payload").eq("marketplace", "shopee").in("event_type", ["6", "16", "22"]).gte("received_at", cutoff.toISOString()));
  const shopeeEvents = new Map();
  for (const activity of shopeeActivities) {
    const payload = activity.raw_payload || {}, data = payload.data || {}, itemId = String(data.item_id || ""), status = String(data.item_status || data.status || "").toUpperCase();
    if (!itemId || !status) continue;
    shopeeEvents.set(`${payload.shop_id}:${itemId}`, { activity, payload, data, status });
  }
  for (const event of shopeeEvents.values()) {
    const account = accounts.find(row => row.marketplace === "shopee" && String(row.shop_id) === String(event.payload.shop_id));
    const link = links.find(row => row.marketplace === "shopee" && row.marketplace_account_id === account?.id && String(row.marketplace_product_id) === String(event.data.item_id));
    if (!account || !link) continue;
    const classification = ["SHOPEE_DELETE", "SELLER_DELETE", "DELETED", "BANNED"].includes(event.status) ? "final" : event.status === "REVIEWING" ? "review" : null;
    if (!classification) continue;
    const detail = event.data.item_status_details?.[0] || {};
    const eventAt = new Date(Number(detail.update_time || event.payload.timestamp || 0) * 1000 || event.activity.received_at);
    await applyModeration({ db, statements, sqlFile, link, account, marketplace: "shopee", status: event.status, classification,
      reason: detail.violation_reason || event.data.violation_reason || (classification === "final" ? "Anúncio encerrado pela Shopee." : "Anúncio em revisão pela Shopee."),
      remedy: detail.suggestion || event.data.suggestion || null, productName: event.data.item_name, eventAt, rawData: event.payload,
      sourceEventId: event.activity.external_event_id || event.activity.id }, cutoff, summary);
  }

  for (const link of links.filter(row => row.marketplace === "shopee")) {
    const status = String(link.status_anuncio || link.raw_data?.item_status || "").toUpperCase();
    const classification = ["SHOPEE_DELETE", "SELLER_DELETE", "DELETED", "BANNED"].includes(status) ? "final" : status === "REVIEWING" ? "review" : null;
    if (!classification || shopeeEvents.has(`${accountById.get(link.marketplace_account_id)?.shop_id}:${link.marketplace_product_id}`)) continue;
    const account = accountById.get(link.marketplace_account_id); if (!account) continue;
    const detail = link.raw_data?.item_status_details?.[0] || {};
    await applyModeration({ db, statements, sqlFile, link, account, marketplace: "shopee", status, classification,
      reason: detail.violation_reason || (classification === "final" ? "Anúncio encerrado pela Shopee." : "Anúncio em revisão pela Shopee."),
      remedy: detail.suggestion || null, productName: link.titulo_marketplace, eventAt: new Date(link.updated_at || Date.now()), rawData: link.raw_data || {} }, cutoff, summary);
  }
  if (sqlFile) fs.writeFileSync(sqlFile, `begin;\n${statements.join("\n")}\ncommit;\n`, "utf8");
  return { ...summary, generatedStatements: statements.length, sqlFile: sqlFile || null };
}

module.exports = { runMarketplaceModerationAudit };
if (require.main === module) runMarketplaceModerationAudit()
  .then(summary => console.log(JSON.stringify(summary, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

async function applyModeration(input, cutoff, summary) {
  const { db, link, account, marketplace, classification } = input;
  summary[marketplace === "mercado_livre" ? "mercadoLivre" : "shopee"][classification]++;
  if (input.sqlFile) {
    if (input.eventAt >= cutoff) {
      const auditRaw = { moderation: input.rawData?.moderation || [], item_status_details: input.rawData?.data?.item_status_details || input.rawData?.item_status_details || [] };
      input.statements.push(`insert into marketplace_listing_moderations(marketplace,marketplace_account_id,store_name,sku,product_name,listing_id,status,classification,reason,remedy,source_event_id,raw_data,event_at,updated_at) values (${q(marketplace)}::marketplace_code,${q(account.id)}::uuid,${q(account.nickname || account.name)},${q(link.sku)},${q(input.productName || link.titulo_marketplace || link.marketplace_product_id)},${q(link.marketplace_product_id)},${q(input.status)},${q(classification)},${q(input.reason)},${q(input.remedy)},${q(input.sourceEventId)},${qj(auditRaw)},${q(input.eventAt.toISOString())}::timestamptz,now()) on conflict(marketplace,marketplace_account_id,listing_id) do update set store_name=excluded.store_name,sku=excluded.sku,product_name=excluded.product_name,status=excluded.status,classification=excluded.classification,reason=excluded.reason,remedy=excluded.remedy,source_event_id=excluded.source_event_id,raw_data=excluded.raw_data,event_at=excluded.event_at,updated_at=now();`);
      summary.recordsWithin30Days++;
    }
    const merged = { ...(link.raw_data || {}), status: input.status, sub_status: input.rawData?.sub_status || link.raw_data?.sub_status || [], moderation_reason: input.reason || null, moderation_remedy: input.remedy || null };
    if (classification === "final") {
      input.statements.push(`update product_marketplaces set product_id=null,existe_no_marketplace=false,status_anuncio=${q(input.status)},raw_data=${qj(merged)},updated_at=now() where id=${q(link.id)}::uuid;`);
      input.statements.push(`delete from listings where marketplace_account_id=${q(account.id)}::uuid and external_listing_id=${q(link.marketplace_product_id)};`);
      summary[marketplace === "mercado_livre" ? "mercadoLivre" : "shopee"].unlinked++;
    } else {
      input.statements.push(`update product_marketplaces set status_anuncio=${q(input.status)},raw_data=${qj(merged)},updated_at=now() where id=${q(link.id)}::uuid;`);
      input.statements.push(`update listings set status='paused',error_message=${q(input.reason || input.remedy)},last_sync_at=now() where marketplace_account_id=${q(account.id)}::uuid and external_listing_id=${q(link.marketplace_product_id)};`);
    }
    return;
  }
  if (input.eventAt >= cutoff) {
    await required(db.from("marketplace_listing_moderations").upsert({ marketplace, marketplace_account_id: account.id,
      store_name: account.nickname || account.name, sku: link.sku || null, product_name: input.productName || link.titulo_marketplace || link.marketplace_product_id,
      listing_id: link.marketplace_product_id, status: input.status, classification, reason: input.reason || null, remedy: input.remedy || null,
      source_event_id: input.sourceEventId || null, raw_data: input.rawData || {}, event_at: input.eventAt.toISOString(), updated_at: new Date().toISOString()
    }, { onConflict: "marketplace,marketplace_account_id,listing_id" }));
    summary.recordsWithin30Days++;
  }
  if (classification === "final") {
    await required(db.from("product_marketplaces").update({ product_id: null, existe_no_marketplace: false, status_anuncio: input.status,
      raw_data: { ...(link.raw_data || {}), ...(input.rawData || {}), moderation_reason: input.reason || null, moderation_remedy: input.remedy || null }, updated_at: new Date().toISOString()
    }).eq("id", link.id));
    await required(db.from("listings").delete().eq("marketplace_account_id", account.id).eq("external_listing_id", link.marketplace_product_id));
    summary[marketplace === "mercado_livre" ? "mercadoLivre" : "shopee"].unlinked++;
  } else {
    await required(db.from("product_marketplaces").update({ status_anuncio: input.status,
      raw_data: { ...(link.raw_data || {}), ...(input.rawData || {}), moderation_reason: input.reason || null, moderation_remedy: input.remedy || null }, updated_at: new Date().toISOString()
    }).eq("id", link.id));
    await required(db.from("listings").update({ status: "paused", error_message: input.reason || input.remedy || null, last_sync_at: new Date().toISOString() })
      .eq("marketplace_account_id", account.id).eq("external_listing_id", link.marketplace_product_id));
  }
}
async function allRows(query) { const rows = []; for (let from = 0; ; from += 1000) { const result = await query.range(from, from + 999); if (result.error) throw result.error; rows.push(...(result.data || [])); if (!result.data || result.data.length < 1000) return rows; } }
async function apiJson(url, token, fallback = null) { const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) return fallback; const text = await response.text(); return text ? JSON.parse(text) : fallback; }
async function required(promise) { const result = await promise; if (result.error) throw result.error; return result.data; }
function q(value) { return value === null || value === undefined || value === "" ? "null" : `'${String(value).replaceAll("'", "''")}'`; }
function qj(value) { return `${q(JSON.stringify(value))}::jsonb`; }
