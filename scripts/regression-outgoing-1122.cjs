const crypto = require("crypto");
require("@next/env").loadEnvConfig(process.cwd());
const { createClient } = require("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } },
);
const SKU = "1122AU",
  PRODUCT = "7fc14d3d-c545-411a-bb68-d29a05aaf204",
  TEST_DESC = "TESTE DE INTEGRACAO 1122AU - 11/08/2026";
const baseShopee = "https://partner.shopeemobile.com";
const sign = (pid, key, path, ts, token = "", shop = "") =>
  crypto
    .createHmac("sha256", key)
    .update(`${pid}${path}${ts}${token}${shop}`)
    .digest("hex");
async function shopeeCall(
  a,
  path,
  { token = a.access_token, method = "GET", query = {}, body } = {},
) {
  const pid = String(a.client_id || process.env.SHOPEE_PARTNER_ID),
    key = String(a.client_secret || process.env.SHOPEE_PARTNER_KEY),
    shop = String(a.shop_id || a.account_id),
    ts = Math.floor(Date.now() / 1000),
    p = new URLSearchParams({
      partner_id: pid,
      timestamp: String(ts),
      sign: sign(pid, key, path, ts, token, token ? shop : ""),
      access_token: token,
      shop_id: shop,
    });
  for (const [k, v] of Object.entries(query)) p.set(k, String(v));
  const r = await fetch(`${baseShopee}${path}?${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${path}: ${JSON.stringify(j)}`);
  return j;
}
async function mlCall(a, path, { method = "GET", body } = {}) {
  const r = await fetch(`https://api.mercadolibre.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${a.access_token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mercado Livre ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
async function activity(account, type, previous, requested, fn) {
  const destination = account.marketplace;
  const { data, error } = await db
    .from("outgoing_marketplace_activities")
    .insert({
      destination,
      activity_type: type,
      product_id: PRODUCT,
      sku: SKU,
      product_name: "Par de Alto Falantes TV 65up7750psb",
      marketplace_account_id: account.id,
      listing_id: requested.listingId || null,
      status: "processing",
      attempt_count: 1,
      previous_data: previous,
      requested_data: requested,
      source_type: "regression_test",
      source_id: "1122AU-20260811",
      processing_started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  try {
    const confirmed = await fn();
    await db
      .from("outgoing_marketplace_activities")
      .update({
        status: "completed",
        listing_id: confirmed.listingId || requested.listingId || null,
        confirmed_data: confirmed,
        processed_at: new Date().toISOString(),
        processing_started_at: null,
      })
      .eq("id", data.id);
    await db
      .from("outgoing_marketplace_activity_history")
      .insert({
        activity_id: data.id,
        attempt: 1,
        stage: "regression_confirmation",
        status: "completed",
        details: confirmed,
      });
    return confirmed;
  } catch (e) {
    await db
      .from("outgoing_marketplace_activities")
      .update({
        status: "error",
        processing_error: e.message,
        processed_at: new Date().toISOString(),
        processing_started_at: null,
      })
      .eq("id", data.id);
    await db
      .from("outgoing_marketplace_activity_history")
      .insert({
        activity_id: data.id,
        attempt: 1,
        stage: "regression_confirmation",
        status: "error",
        details: { error: e.message },
      });
    throw e;
  }
}
async function main() {
  const [
    { data: p },
    { data: stock },
    { data: accounts },
    { data: type },
    { data: mappings },
  ] = await Promise.all([
    db
      .from("products")
      .select(
        "sku,title,description,price,product_images(position,cloudinary_url,url)",
      )
      .eq("id", PRODUCT)
      .single(),
    db
      .from("estoque")
      .select("estoque_disponivel")
      .eq("product_id", PRODUCT)
      .single(),
    db
      .from("config_marketplace_accounts")
      .select("*")
      .eq("active", true)
      .in("marketplace", ["mercado_livre", "shopee"])
      .order("name"),
    db.from("config_types").select("*").eq("code", "AU").single(),
      db.from("marketplace_category_mappings").select("*"),
    ]);
  const map =
    (mappings || []).find(
      (entry) =>
        entry.internal_category === "AU" ||
        entry.internal_category === type.marketplace_category,
    ) || {};
  const images = p.product_images
    .sort((a, b) => a.position - b.position)
    .map((x) => x.cloudinary_url || x.url)
    .filter(Boolean);
  if (process.argv.includes("--shopee-attributes")) {
    const account = accounts.find((entry) => entry.marketplace === "shopee");
    const category = Number(map?.shopee_code);
    const attempts = [];
    for (const [path, query] of [
      ["/api/v2/product/get_attribute_tree", { category_id_list: category, language: "pt-br" }],
      ["/api/v2/product/get_attribute_tree", { category_id: category, language: "pt-br" }],
      ["/api/v2/product/get_item_limit", { category_id: category }],
    ]) {
      try { attempts.push({ path, query, result: await shopeeCall(account, path, { query }) }); }
      catch (error) { attempts.push({ path, query, error: error.message }); }
    }
    console.log(JSON.stringify(attempts, null, 2));
    return;
  }
  const results = [];
  for (const a of accounts.filter(
    (account) =>
      !process.argv.includes("--ml-only") ||
      account.marketplace === "mercado_livre",
  )) {
    if (process.argv.includes("--shopee-only") && a.marketplace !== "shopee") continue;
    try {
      if (a.marketplace === "mercado_livre") {
        const category = map?.mercado_livre_code || type.marketplace_category;
        if (!category)
          throw new Error("Categoria Mercado Livre nao mapeada para AU.");
        const created = await activity(
          a,
          "listing_create",
          {},
          {
            title: p.title,
            description: p.description,
            stock: stock.estoque_disponivel,
          },
          async () => {
            const item = await mlCall(a, "/items", {
              method: "POST",
              body: {
            family_name: p.title.slice(0, 60),
                category_id: category,
                price: Number(p.price),
                currency_id: "BRL",
                available_quantity: Number(stock.estoque_disponivel),
                buying_mode: "buy_it_now",
                condition: "used",
                listing_type_id: "gold_special",
                sale_terms: [
                  {
                    id: "WARRANTY_TYPE",
                    value_id: "2230280",
                    value_name: "Garantia do vendedor",
                  },
                  {
                    id: "WARRANTY_TIME",
                    value_name: `${Number(type.warranty_months || 0)} meses`,
                  },
                ],
                pictures: images.map((source) => ({ source })),
                attributes: [
                  { id: "SELLER_SKU", value_name: SKU },
                  { id: "BRAND", value_name: "LG" },
                  { id: "MODEL", value_name: "65UP7750PSB" },
                  { id: "PART_NUMBER", value_name: "65UP7750PSB" },
                  {
                    id: "ITEM_CONDITION",
                    value_id: "2230581",
                    value_name: "Usado",
                  },
                  { id: "SELLER_PACKAGE_HEIGHT", value_name: "6 cm" },
                  { id: "SELLER_PACKAGE_WIDTH", value_name: "25 cm" },
                  { id: "SELLER_PACKAGE_LENGTH", value_name: "20 cm" },
                  { id: "SELLER_PACKAGE_WEIGHT", value_name: "400 g" },
                ],
              },
            });
            await mlCall(a, `/items/${item.id}/description`, {
              method: "POST",
              body: {
                plain_text: p.description.replace(/<br\s*\/?\s*>/gi, "\n"),
              },
            });
            return { listingId: item.id, status: item.status };
          },
        );
        const id = created.listingId;
        await activity(
          a,
          "listing_update",
          { description: p.description },
          { listingId: id, description: TEST_DESC },
          async () => {
            await mlCall(a, `/items/${id}/description`, {
              method: "PUT",
              body: { plain_text: TEST_DESC },
            });
            const d = await mlCall(a, `/items/${id}/description`);
            if (!String(d.plain_text || "").includes("1122AU"))
              throw new Error("Descricao ML nao confirmada");
            return { listingId: id, description: d.plain_text };
          },
        );
        await activity(
          a,
          "stock_update",
          { stock: stock.estoque_disponivel },
          { listingId: id, stock: 0, status: "paused" },
          async () => {
            await mlCall(a, `/items/${id}`, {
              method: "PUT",
              body: { status: "paused" },
            });
            const x = await mlCall(a, `/items/${id}`);
            if (x.status !== "paused") throw new Error(`Status ${x.status}`);
            return {
              listingId: id,
              stock: x.available_quantity,
              status: x.status,
            };
          },
        );
        await activity(
          a,
          "listing_delete",
          { status: "paused" },
          { listingId: id, status: "deleted" },
          async () => {
            await mlCall(a, `/items/${id}`, {
              method: "PUT",
              body: { status: "closed" },
            });
            try {
              await mlCall(a, `/items/${id}`, {
                method: "PUT",
                body: { deleted: "true" },
              });
            } catch (e) {}
            const x = await mlCall(a, `/items/${id}`);
            if (!["closed", "inactive"].includes(x.status))
              throw new Error(`Status final ${x.status}`);
            return { listingId: id, status: x.status, deleted: true };
          },
        );
      } else {
        const category = map?.shopee_code;
        if (!category) throw new Error("Categoria Shopee nao mapeada para AU.");
        const logistics = await shopeeCall(
          a,
          "/api/v2/logistics/get_channel_list",
        );
        const enabled = (logistics.response?.logistics_channel_list || [])
          .filter((x) => x.enabled)
          .map((x) => ({
            logistic_id: Number(x.logistics_channel_id),
            enabled: true,
          }));
        const uploaded = [];
        for (const url of images) {
          const image = await fetch(url),
            form = new FormData(),
            pid = String(a.client_id || process.env.SHOPEE_PARTNER_ID),
            key = String(a.client_secret || process.env.SHOPEE_PARTNER_KEY),
            shop = String(a.shop_id || a.account_id),
            path = "/api/v2/media_space/upload_image",
            ts = Math.floor(Date.now() / 1000),
            q = new URLSearchParams({
              partner_id: pid,
              timestamp: String(ts),
              sign: sign(pid, key, path, ts, a.access_token, shop),
              access_token: a.access_token,
              shop_id: shop,
            });
          form.append(
            "image",
            new Blob([await image.arrayBuffer()]),
            "product.jpg",
          );
          const rr = await fetch(`${baseShopee}${path}?${q}`, {
              method: "POST",
              body: form,
            }),
            jj = await rr.json();
          if (jj.error) throw new Error(JSON.stringify(jj));
          uploaded.push(
            jj.response?.image_info?.image_id || jj.response?.image_id,
          );
        }
        const created = await activity(
          a,
          "listing_create",
          {},
          { title: p.title, stock: stock.estoque_disponivel },
          async () => {
            const x = await shopeeCall(a, "/api/v2/product/add_item", {
              method: "POST",
              body: {
                item_name: p.title.slice(0, 120),
                description: p.description.replace(/<br\s*\/?\s*>/gi, "\n"),
                item_sku: SKU,
                category_id: Number(category),
                original_price: Number(p.price),
                seller_stock: [{ stock: Number(stock.estoque_disponivel) }],
                image: { image_id_list: uploaded },
                weight: Number(type.weight_gross || 0.4),
                dimension: {
                  package_length: Number(type.length || 20),
                  package_width: Number(type.width || 25),
                  package_height: Number(type.height || 6),
                },
                logistic_info: enabled,
                condition: "USED",
                gtin_code: "00",
                brand: { brand_id: 0, original_brand_name: "LG" },
                attribute_list: [
                  { attribute_id: 100370, attribute_value_list: [{ value_id: 2437, original_value_name: "Supplier Warranty" }] },
                  { attribute_id: 100121, attribute_value_list: [{ value_id: 799, original_value_name: "3 Months" }] },
                ],
              },
            });
            const id = x.response?.item_id;
            if (!id) throw new Error(JSON.stringify(x));
            return { listingId: String(id), status: "NORMAL" };
          },
        );
        const id = created.listingId;
        await activity(
          a,
          "listing_update",
          { description: p.description },
          { listingId: id, description: TEST_DESC },
          async () => {
            await shopeeCall(a, "/api/v2/product/update_item", {
              method: "POST",
              body: { item_id: Number(id), description: TEST_DESC },
            });
            const x = await shopeeCall(
                a,
                "/api/v2/product/get_item_base_info",
                { query: { item_id_list: id } },
              ),
              item = x.response?.item_list?.[0] || {};
            if (!String(item.description || "").includes("1122AU"))
              throw new Error("Descricao Shopee nao confirmada");
            return { listingId: id, description: item.description };
          },
        );
        await activity(
          a,
          "stock_update",
          { stock: stock.estoque_disponivel },
          { listingId: id, stock: 0, status: "zero" },
          async () => {
            await shopeeCall(a, "/api/v2/product/update_stock", {
              method: "POST",
              body: {
                item_id: Number(id),
                stock_list: [{ seller_stock: [{ stock: 0 }] }],
              },
            });
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const x = await shopeeCall(
                a,
                "/api/v2/product/get_item_base_info",
                { query: { item_id_list: id } },
              ),
              item = x.response?.item_list?.[0] || {},
              n = Number(
                item.stock_info_v2?.seller_stock?.[0]?.stock ?? item.stock_info_v2?.summary_info?.total_available_stock ?? -1,
              );
            if (n !== 0) throw new Error(`Estoque ${n}`);
            return { listingId: id, stock: n, status: item.item_status };
          },
        );
        await activity(
          a,
          "listing_delete",
          { status: "NORMAL" },
          { listingId: id, status: "deleted" },
          async () => {
            await shopeeCall(a, "/api/v2/product/delete_item", {
              method: "POST",
              body: { item_id: Number(id) },
            });
            return { listingId: id, status: "deleted" };
          },
        );
      }
      results.push({ store: a.name, ok: true });
    } catch (e) {
      results.push({ store: a.name, ok: false, error: e.message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
