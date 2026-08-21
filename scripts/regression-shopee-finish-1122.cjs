const crypto = require("crypto");
require("@next/env").loadEnvConfig(process.cwd());
const { createClient } = require("@supabase/supabase-js");
const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } },
  ),
  base = "https://partner.shopeemobile.com",
  PRODUCT = "7fc14d3d-c545-411a-bb68-d29a05aaf204";
const sign = (p, k, path, t, token, shop) =>
  crypto
    .createHmac("sha256", k)
    .update(`${p}${path}${t}${token}${shop}`)
    .digest("hex");
async function call(a, path, method = "GET", body, query = {}) {
  const p = String(a.client_id || process.env.SHOPEE_PARTNER_ID),
    k = String(a.client_secret || process.env.SHOPEE_PARTNER_KEY),
    s = String(a.shop_id || a.account_id),
    t = Math.floor(Date.now() / 1000),
    q = new URLSearchParams({
      partner_id: p,
      timestamp: String(t),
      sign: sign(p, k, path, t, a.access_token, s),
      access_token: a.access_token,
      shop_id: s,
      ...query,
    });
  const r = await fetch(`${base}${path}?${q}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(JSON.stringify(j));
  return j;
}
async function log(a, type, id, previous, requested, fn) {
  const { data } = await db
    .from("outgoing_marketplace_activities")
    .insert({
      destination: "shopee",
      activity_type: type,
      product_id: PRODUCT,
      sku: "1122AU",
      product_name: "Par de Alto Falantes TV 65up7750psb",
      marketplace_account_id: a.id,
      listing_id: id,
      status: "processing",
      attempt_count: 1,
      previous_data: previous,
      requested_data: requested,
      source_type: "regression_test",
      source_id: "1122AU-20260811",
    })
    .select("id")
    .single();
  try {
    const confirmed = await fn();
    await db
      .from("outgoing_marketplace_activities")
      .update({
        status: "completed",
        confirmed_data: confirmed,
        processed_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    return confirmed;
  } catch (e) {
    await db
      .from("outgoing_marketplace_activities")
      .update({
        status: "error",
        processing_error: e.message,
        processed_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    throw e;
  }
}
(async () => {
  const { data: created } = await db
    .from("outgoing_marketplace_activities")
    .select("marketplace_account_id,listing_id,config_marketplace_accounts(*)")
    .eq("sku", "1122AU")
    .eq("destination", "shopee")
    .eq("activity_type", "listing_create")
    .eq("status", "completed")
    .not("listing_id", "is", null)
    .order("created_at", { ascending: false });
  const seen = new Set(),
    out = [];
  for (const row of created || []) {
    if (seen.has(row.marketplace_account_id)) continue;
    seen.add(row.marketplace_account_id);
    const a = row.config_marketplace_accounts,
      id = row.listing_id;
    try {
      await log(
        a,
        "stock_update",
        id,
        { stock: 1 },
        { stock: 0, status: "zero" },
        async () => {
          await call(a, "/api/v2/product/update_stock", "POST", {
            item_id: Number(id),
            stock_list: [{ seller_stock: [{ stock: 0 }] }],
          });
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const x = await call(
              a,
              "/api/v2/product/get_item_base_info",
              "GET",
              null,
              { item_id_list: id },
            ),
            item = x.response?.item_list?.[0] || {},
            n = Number(
              item.stock_info_v2?.seller_stock?.[0]?.stock ??
                item.stock_info_v2?.summary_info?.total_available_stock ??
                -1,
            );
          if (n !== 0)
            throw new Error(
              `Estoque confirmado ${n}: ${JSON.stringify(item.stock_info_v2)}`,
            );
          return { stock: n, status: item.item_status };
        },
      );
      await log(
        a,
        "listing_delete",
        id,
        { status: "NORMAL" },
        { status: "deleted" },
        async () => {
          await call(a, "/api/v2/product/delete_item", "POST", {
            item_id: Number(id),
          });
          return { status: "deleted", listingId: id };
        },
      );
      out.push({ store: a.name, stock: true, deleted: true });
    } catch (e) {
      out.push({ store: a.name, error: e.message });
    }
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
