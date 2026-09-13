import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import {
  CUTOFF_ISO,
  POLICY,
  isLegacyCandidate,
  sha256,
} from "../lib/cloudinary-legacy-optimize.mjs";
import { mercadoLivreReadHeaders } from "../lib/cloudinary-stage2-pilot.mjs";

const PILOT_IDS = [
  "produtos/LG/1239KTKT_32LN5400_02",
  "produtos/LG/815PFPF_65NANO81SNA_EAX68248021_02_2dedb9ca58",
  "produtos/LG/816PFDPF_55QNED80SRA_EAY65895417_04_8801e764b0",
];
let IDS = PILOT_IDS,
  ROOT = process.cwd(),
  OUT = path.join(ROOT, "artifacts", "cloudinary-stage2-pilot"),
  BACKUPS = path.join(OUT, "backups");
const TIMEOUT = 20000;
const report = {
  started_at: new Date().toISOString(),
  authorized_public_ids: IDS,
  policy: POLICY,
  database_writes: 0,
  marketplace_writes: 0,
  assets: [],
  status: "RUNNING",
};
function env(file) {
  if (!fs.existsSync(file)) return;
  for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v.replace(/\\n/g, "\n");
  }
}
const basic = (a) =>
  `Basic ${Buffer.from(`${a.key}:${a.secret}`).toString("base64")}`;
function safeMessage(value) {
  const text = String(value || "falha externa")
    .replace(/(Basic|Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /(access_token|client_secret|api_key|signature|sign)=?[^\s&,]*/gi,
      "$1=[REDACTED]",
    );
  return text.slice(0, 500);
}
class ExternalCallError extends Error {
  constructor({ source, operation, status, method, hostname, message }) {
    super(`${source}/${operation}: HTTP ${status} ${safeMessage(message)}`);
    this.name = "ExternalCallError";
    this.source = source;
    this.operation = operation;
    this.http_status = status;
    this.method = method;
    this.hostname = hostname;
    this.safe_message = safeMessage(message);
  }
}
async function req(url, options = {}, binary = false, context = {}) {
  const parsed = new URL(url),
    method = String(options.method || "GET").toUpperCase(),
    source = context.source || "external",
    operation = context.operation || "request";
  let r;
  try {
    r = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    throw new ExternalCallError({
      source,
      operation,
      status: 0,
      method,
      hostname: parsed.hostname,
      message: error?.name === "TimeoutError" ? "timeout" : "network failure",
    });
  }
  if (binary) {
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok)
      throw new ExternalCallError({
        source,
        operation,
        status: r.status,
        method,
        hostname: parsed.hostname,
        message: r.headers.get("x-cld-error") || "binary response rejected",
      });
    return b;
  }
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b?.error)
    throw new ExternalCallError({
      source,
      operation,
      status: r.status,
      method,
      hostname: parsed.hostname,
      message: b?.error?.message || b?.message || b?.error || "falha externa",
    });
  return b;
}
async function rows(db, table, columns) {
  const out = [];
  for (let n = 0; ; n += 1000) {
    const r = await db
      .from(table)
      .select(columns)
      .range(n, n + 999);
    if (r.error) throw Error(`${table}: ${r.error.message}`);
    out.push(...(r.data || []));
    if (!r.data || r.data.length < 1000) return out;
  }
}
const detail = (a, id) =>
  req(
    `https://api.cloudinary.com/v1_1/${a.cloud}/resources/${encodeURIComponent(id)}?versions=true&max_results=100`,
    { headers: { Authorization: basic(a) } },
    false,
    { source: "cloudinary", operation: "asset-details" },
  );
const usage = (a) =>
  req(
    `https://api.cloudinary.com/v1_1/${a.cloud}/usage`,
    { headers: { Authorization: basic(a) } },
    false,
    { source: "cloudinary", operation: "usage" },
  );
async function upload(a, file, asset) {
  const f = new FormData();
  f.set(
    "file",
    new Blob([file], {
      type: asset.format === "png" ? "image/png" : "image/jpeg",
    }),
    `asset.${asset.format}`,
  );
  f.set("public_id", asset.public_id);
  f.set("backup", "true");
  f.set("overwrite", "true");
  f.set("invalidate", "true");
  return req(
    `https://api.cloudinary.com/v1_1/${a.cloud}/image/upload`,
    { method: "POST", headers: { Authorization: basic(a) }, body: f },
    false,
    { source: "cloudinary", operation: "upload" },
  );
}
async function restore(a, assetId, versionId) {
  const f = new URLSearchParams();
  f.append("asset_ids[]", assetId);
  f.append("versions[]", versionId);
  return req(
    `https://api.cloudinary.com/v1_1/${a.cloud}/resources/restore`,
    {
      method: "POST",
      headers: {
        Authorization: basic(a),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: f,
    },
    false,
    { source: "cloudinary", operation: "restore" },
  );
}
async function backupDownload(a, assetId, versionId) {
  const q = new URLSearchParams({ asset_id: assetId, version_id: versionId });
  return req(
    `https://api.cloudinary.com/v1_1/${a.cloud}/download_backup?${q}`,
    { headers: { Authorization: basic(a) } },
    true,
    { source: "cloudinary", operation: "backup-download" },
  );
}
async function optimize(b, format) {
  let p = sharp(b, { failOn: "warning" }).rotate().resize({
    width: 1200,
    height: 1200,
    fit: "inside",
    withoutEnlargement: true,
  });
  return /png/i.test(format)
    ? p.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : p
        .jpeg({
          quality: 88,
          progressive: true,
          chromaSubsampling: "4:4:4",
          mozjpeg: true,
        })
        .toBuffer();
}
function urls(value, out = new Set()) {
  if (
    typeof value === "string" &&
    /^https?:\/\//i.test(value) &&
    /(cloudinary|mlstatic|shopee|image|picture|photo|thumbnail)/i.test(value)
  )
    out.add(value);
  else if (Array.isArray(value)) for (const x of value) urls(x, out);
  else if (value && typeof value === "object")
    for (const x of Object.values(value)) urls(x, out);
  return [...out];
}
async function inspect(
  url,
  context = { source: "persisted-image", operation: "download" },
) {
  const b = await req(
    `${url}${url.includes("?") ? "&" : "?"}_stage2b=${Date.now()}`,
    { cache: "no-store" },
    true,
    context,
  );
  const m = await sharp(b).metadata();
  return {
    url: url.split("?")[0],
    ok: true,
    bytes: b.length,
    width: m.width,
    height: m.height,
    format: m.format,
    sha256: sha256(b),
  };
}
async function inspectMany(list, context) {
  const out = [];
  for (const url of [...new Set(list)]) out.push(await inspect(url, context));
  return out;
}
function shopeeUrl(account, itemId) {
  const api = "/api/v2/product/get_item_base_info",
    partner = String(account.client_id || process.env.SHOPEE_PARTNER_ID || ""),
    key = String(account.client_secret || process.env.SHOPEE_PARTNER_KEY || ""),
    shop = String(account.shop_id || account.account_id || ""),
    ts = Math.floor(Date.now() / 1000);
  if (!partner || !key || !shop || !account.access_token)
    throw Error("Shopee sem credenciais de leitura");
  const sign = crypto
    .createHmac("sha256", key)
    .update(`${partner}${api}${ts}${account.access_token}${shop}`)
    .digest("hex");
  return `https://partner.shopeemobile.com${api}?${new URLSearchParams({ partner_id: partner, timestamp: String(ts), sign, access_token: account.access_token, shop_id: shop, item_id_list: String(itemId) })}`;
}
async function marketSnapshot(link, accounts, tinyToken, product) {
  if (link.marketplace === "mercado_livre") {
    const headers = mercadoLivreReadHeaders(link, accounts);
    const body = await req(
      `https://api.mercadolibre.com/items/${encodeURIComponent(link.marketplace_product_id)}?attributes=id,status,pictures`,
      { headers },
      false,
      { source: "mercado-livre", operation: "item-details" },
    );
    const pics = (body.pictures || [])
      .map((x) => x.secure_url || x.url)
      .filter(Boolean);
    return {
      marketplace: "mercado_livre",
      id: link.marketplace_product_id,
      status: body.status,
      image_urls: pics,
      image_checks: await inspectMany(pics, {
        source: "mercado-livre",
        operation: "image-download",
      }),
    };
  }
  if (link.marketplace === "shopee") {
    const account = accounts.find(
      (x) => String(x.id) === String(link.marketplace_account_id),
    );
    if (!account) throw Error("conta Shopee não encontrada");
    if (
      account.token_expires_at &&
      Date.parse(account.token_expires_at) <= Date.now()
    )
      throw Error("token Shopee expirado; refresh proibido");
    const body = await req(
      shopeeUrl(account, link.marketplace_product_id),
      {},
      false,
      { source: "shopee", operation: "item-base-info" },
    );
    const item = body.response?.item_list?.[0];
    if (!item) throw Error("item Shopee não encontrado");
    const pics = item.image?.image_url_list || [];
    return {
      marketplace: "shopee",
      id: String(item.item_id),
      status: item.item_status,
      image_urls: pics,
      image_ids: item.image?.image_id_list || [],
      image_checks: await inspectMany(pics, {
        source: "shopee",
        operation: "image-download",
      }),
    };
  }
  return {
    marketplace: link.marketplace,
    id: link.marketplace_product_id,
    status: "N/A",
    image_urls: [],
    image_checks: [],
  };
}
async function tinySnapshot(product, token) {
  if (!product?.tiny_product_id) return { status: "N/A" };
  if (!token) throw Error("Tiny sem token");
  const f = new URLSearchParams({
    token,
    formato: "JSON",
    id: String(product.tiny_product_id),
  });
  const body = await req(
    "https://api.tiny.com.br/api2/produto.obter.php",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: f,
    },
    false,
    { source: "tiny", operation: "product-details" },
  );
  const p = body.retorno?.produto;
  if (!p) throw Error("produto Tiny não encontrado");
  const pics = urls(p);
  return {
    id: String(product.tiny_product_id),
    status: p.situacao || "OK",
    image_urls: pics,
    image_checks: await inspectMany(pics, {
      source: "tiny",
      operation: "image-download",
    }),
  };
}
const comparable = (s) =>
  JSON.stringify({
    id: s.id,
    status: s.status,
    image_urls: s.image_urls,
    image_ids: s.image_ids || [],
  });
function save() {
  fs.mkdirSync(OUT, { recursive: true });
  report.finished_at = new Date().toISOString();
  const totalBefore = report.assets.reduce(
      (s, x) => s + Number(x.before?.bytes || 0),
      0,
    ),
    totalAfter = report.assets.reduce(
      (s, x) =>
        s +
        Number(
          x.after?.bytes ||
            (x.rollback?.matches_original ? x.before?.bytes : 0) ||
            0,
        ),
      0,
    ),
    approved = report.assets.filter((x) => x.status === "APPROVED").length,
    rollbacks = report.assets.filter((x) => x.rollback?.performed).length;
  report.summary = {
    planned: IDS.length,
    processed: report.assets.filter((x) => x.after || x.rollback?.performed)
      .length,
    approved,
    rollbacks,
    bytes_before: totalBefore,
    bytes_after: totalAfter,
    savings_bytes: totalBefore - totalAfter,
    savings_percent: totalBefore
      ? Number((((totalBefore - totalAfter) * 100) / totalBefore).toFixed(2))
      : 0,
    public_ids: IDS,
    statuses: report.assets.map((x) => ({
      public_id: x.public_id,
      status: x.status,
    })),
  };
  fs.writeFileSync(
    path.join(OUT, "report.json"),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, "report.md"),
    `# Cloudinary ${IDS.length === 20 ? "Etapa 2C — lote controlado" : "Etapa 2B — piloto real"}\n\nStatus: **${report.status}**\n\nPlanejados: ${IDS.length}. Processados: ${report.summary.processed}. Aprovados: ${approved}. Rollbacks: ${rollbacks}.\n\nAntes: ${totalBefore} bytes. Depois: ${totalAfter} bytes. Economia: ${totalBefore - totalAfter} bytes (${report.summary.savings_percent}%).\n\nBackups nativos e externos foram preservados. Banco e marketplaces não receberam escrita.\n`,
  );
}

async function main() {
  let batchManifest = [];
  const arg = process.argv[2],
    batch =
      arg === "--execute-stage2c-20-internal" &&
      process.env.STAGE2C_BATCH_LAUNCH === "confirmed-exact-20",
    mode =
      arg === "--preflight-only"
        ? "preflight"
        : arg === "--execute-stage2b-exact-3" || batch
          ? "execute"
          : null;
  if (batch) {
    const manifest = JSON.parse(process.env.STAGE2C_BATCH_MANIFEST || "[]");
    if (
      manifest.length !== 20 ||
      new Set(manifest.map((item) => item.public_id)).size !== 20
    ) {
      throw Error("Manifesto interno inválido");
    }
    IDS = manifest.map((item) => item.public_id);
    batchManifest = manifest;
    OUT = path.join(ROOT, "artifacts", "cloudinary-stage2-batch");
    BACKUPS = path.join(OUT, "backups");
    report.authorized_public_ids = IDS;
    report.manifest = manifest;
  }
  if (!mode || process.argv.length !== 3)
    throw Error("Use --preflight-only ou o executor explícito autorizado.");
  report.mode = mode;
  report.phase = "preflight";
  env(path.join(ROOT, ".env.local"));
  env(path.join(ROOT, ".env.vercel.local"));
  const dbKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, dbKey, {
      auth: { persistSession: false },
    });
  const [images, products, links, listings, pending, accounts, sr] =
    await Promise.all([
      rows(
        db,
        "product_images",
        "id,product_id,position,status,url,cloudinary_url,cloudinary_public_id,cloudinary_cloud_name,cloudinary_asset_id,bytes,width_px,height_px",
      ),
      rows(db, "products", "id,sku,status,tiny_product_id"),
      rows(
        db,
        "product_marketplaces",
        "id,product_id,sku,marketplace,marketplace_account_id,marketplace_product_id,status_anuncio,raw_data",
      ),
      rows(
        db,
        "listings",
        "id,product_id,marketplace,external_listing_id,external_sku,status",
      ),
      db
        .from("outgoing_marketplace_activities")
        .select("id,product_id,sku,status,activity_type")
        .in("status", ["pending", "queued", "processing", "retry", "running"])
        .limit(1000),
      rows(
        db,
        "config_marketplace_accounts",
        "id,marketplace,account_id,shop_id,access_token,token_expires_at,client_id,client_secret,active",
      ),
      db
        .from("settings")
        .select("key,value")
        .in("key", [
          "CLOUDINARY_CLOUD_NAME",
          "CLOUDINARY_API_KEY",
          "CLOUDINARY_API_SECRET",
          "TINY_TOKEN",
        ]),
    ]);
  if (pending.error || sr.error)
    throw Error(pending.error?.message || sr.error.message);
  const sm = new Map(sr.data.map((x) => [x.key, String(x.value || "")])),
    a = {
      cloud: sm.get("CLOUDINARY_CLOUD_NAME"),
      key: sm.get("CLOUDINARY_API_KEY"),
      secret: sm.get("CLOUDINARY_API_SECRET"),
    };
  report.usage_before = await usage(a);
  const prepared = [];
  for (const [index, publicId] of IDS.entries()) {
    report.current_public_id = publicId;
    console.log(`[PREFLIGHT ${index + 1}/${IDS.length}] ${publicId}`);
    const row = images.find(
      (x) =>
        x.cloudinary_public_id === publicId ||
        String(x.cloudinary_url || x.url).includes(publicId),
    );
    if (!row) throw Error(`${publicId}: referência ausente`);
    const d = await req(
      `https://api.cloudinary.com/v1_1/${a.cloud}/resources/image/upload/${encodeURIComponent(publicId)}?versions=true`,
      { headers: { Authorization: basic(a) } },
      false,
      { source: "cloudinary", operation: "asset-preflight" },
    );
    if (batch) {
      const expected = batchManifest.find(
        (item) => item.public_id === publicId,
      );
      if (!expected || expected.asset_id !== d.asset_id)
        throw Error(`${publicId}: asset_id divergiu do manifesto aprovado`);
    }
    console.log("[OK] Cloudinary");
    const verdict = isLegacyCandidate(d, images, CUTOFF_ISO);
    if (!verdict.eligible) throw Error(`${publicId}: ${verdict.reason}`);
    const product = products.find(
      (x) => String(x.id) === String(row.product_id),
    );
    const relatedLinks = links.filter(
        (x) => String(x.product_id) === String(row.product_id),
      ),
      relatedListings = listings.filter(
        (x) => String(x.product_id) === String(row.product_id),
      );
    if (
      (pending.data || []).some(
        (x) =>
          String(x.product_id) === String(row.product_id) ||
          String(x.sku).toUpperCase() === String(product?.sku).toUpperCase(),
      )
    )
      throw Error(`${publicId}: operação pendente`);
    const persisted = [
      ...new Set([row.url, row.cloudinary_url].filter(Boolean)),
    ];
    const persistedChecks = await inspectMany(persisted, {
      source: "persisted-image",
      operation: "preflight-download",
    });
    console.log("[OK] URLs persistidas");
    const markets = [];
    for (const link of relatedLinks) {
      console.log(
        `[CHECK] ${link.marketplace === "mercado_livre" ? "Mercado Livre" : link.marketplace === "shopee" ? "Shopee" : link.marketplace} ${link.marketplace_product_id}`,
      );
      markets.push(
        await marketSnapshot(link, accounts, sm.get("TINY_TOKEN"), product),
      );
    }
    console.log(`[CHECK] Tiny ${product?.tiny_product_id || "N/A"}`);
    const tiny = await tinySnapshot(product, sm.get("TINY_TOKEN"));
    prepared.push({
      asset: d,
      row,
      product,
      links: relatedLinks,
      listings: relatedListings,
      persisted,
      persistedChecks,
      markets,
      tiny,
    });
    console.log(`[OK] PREFLIGHT ${index + 1}/${IDS.length}`);
  }
  report.preflight = {
    ok: true,
    checked_at: new Date().toISOString(),
    count: prepared.length,
    assets: prepared.map((x) => ({
      public_id: x.asset.public_id,
      asset_id: x.asset.asset_id,
      persisted_urls: x.persisted,
      marketplaces: x.markets.map((m) => ({
        marketplace: m.marketplace,
        id: m.id,
        status: m.status,
        image_count: m.image_urls.length,
      })),
      tiny: {
        id: x.tiny.id || null,
        status: x.tiny.status,
        image_count: x.tiny.image_urls?.length || 0,
      },
    })),
  };
  delete report.current_public_id;
  if (mode === "preflight") {
    report.status = "PASS";
    save();
    console.log("PASS: preflight concluído sem qualquer escrita.");
    return;
  }
  report.phase = "execute";
  fs.mkdirSync(BACKUPS, { recursive: true });
  for (const p of prepared) {
    const asset = p.asset,
      entry = { public_id: asset.public_id, status: "PROCESSING" };
    report.assets.push(entry);
    const fresh = await detail(a, asset.asset_id);
    const freshRow = await db
      .from("product_images")
      .select(
        "id,product_id,position,url,cloudinary_url,cloudinary_public_id,cloudinary_asset_id",
      )
      .eq("id", p.row.id)
      .single();
    if (
      freshRow.error ||
      fresh.asset_id !== asset.asset_id ||
      !isLegacyCandidate(fresh, [freshRow.data], CUTOFF_ISO).eligible
    )
      throw Error(`${asset.public_id}: revalidação imediata falhou`);
    const original = await req(asset.secure_url, { cache: "no-store" }, true),
      originalHash = sha256(original),
      meta = await sharp(original).metadata(),
      optimized = await optimize(original, asset.format),
      om = await sharp(optimized).metadata();
    const file = path.join(
      BACKUPS,
      `${asset.asset_id}__v${asset.version}.${asset.format}`,
    );
    fs.writeFileSync(file, original);
    if (sha256(fs.readFileSync(file)) !== originalHash)
      throw Error(`${asset.public_id}: backup externo inválido`);
    entry.before = {
      public_id: asset.public_id,
      asset_id: asset.asset_id,
      version: asset.version,
      version_id: asset.version_id || null,
      secure_url: asset.secure_url,
      format: asset.format,
      width: meta.width,
      height: meta.height,
      bytes: original.length,
      sha256: originalHash,
      derived_count: (asset.derived || []).length,
      derived_bytes: (asset.derived || []).reduce(
        (s, x) => s + Number(x.bytes || 0),
        0,
      ),
      references: {
        product_images: {
          id: p.row.id,
          product_id: p.row.product_id,
          position: p.row.position,
          columns: [
            "url",
            "cloudinary_url",
            "cloudinary_public_id",
            "cloudinary_asset_id",
          ],
        },
        listings: p.listings,
      },
      urls: p.persisted,
      marketplaces: p.markets,
      tiny: p.tiny,
    };
    entry.external_backup = {
      path: file,
      bytes: original.length,
      sha256: originalHash,
      valid: true,
    };
    const armed = await upload(a, original, asset);
    if (
      armed.public_id !== asset.public_id ||
      armed.asset_id !== asset.asset_id
    )
      throw Error(`${asset.public_id}: identidade mudou ao ativar backup`);
    const armedDetail = await detail(a, asset.asset_id);
    const native = (armedDetail.versions || []).find(
      (x) => String(x.version) === String(armed.version),
    );
    if (!armedDetail.backup || !native?.version_id)
      throw Error(`${asset.public_id}: backup nativo não criado`);
    const nativeBytes = await backupDownload(
      a,
      asset.asset_id,
      native.version_id,
    );
    if (sha256(nativeBytes) !== originalHash)
      throw Error(`${asset.public_id}: backup nativo divergiu`);
    entry.backup = {
      armed_version: armed.version,
      version_id: native.version_id,
      download_sha256: sha256(nativeBytes),
      recoverable: true,
    };
    const changed = await upload(a, optimized, asset);
    try {
      if (
        changed.public_id !== asset.public_id ||
        changed.asset_id !== asset.asset_id ||
        Number(changed.version) <= Number(armed.version)
      )
        throw Error("identidade/versão inválida");
      const after = await detail(a, asset.asset_id),
        delivered = await req(
          `${changed.secure_url}?_validate=${Date.now()}`,
          { cache: "no-store" },
          true,
        ),
        deliveredHash = sha256(delivered);
      if (
        deliveredHash !== sha256(optimized) ||
        Number(after.bytes) >= original.length ||
        Math.max(after.width, after.height) > 1200
      )
        throw Error("conteúdo otimizado inválido");
      const persistedAfter = await inspectMany(p.persisted),
        unversioned = await inspect(
          changed.secure_url.replace(/\/v\d+\//, "/"),
        );
      const marketsAfter = [];
      for (const link of p.links)
        marketsAfter.push(
          await marketSnapshot(link, accounts, sm.get("TINY_TOKEN"), p.product),
        );
      const tinyAfter = await tinySnapshot(p.product, sm.get("TINY_TOKEN"));
      if (
        marketsAfter.some(
          (x, i) => comparable(x) !== comparable(p.markets[i]),
        ) ||
        comparable(tinyAfter) !== comparable(p.tiny)
      )
        throw Error("marketplace apresentou diferença");
      const currentRow = await db
        .from("product_images")
        .select(
          "id,product_id,position,url,cloudinary_url,cloudinary_public_id,cloudinary_asset_id",
        )
        .eq("id", p.row.id)
        .single();
      if (
        currentRow.error ||
        JSON.stringify(currentRow.data) !==
          JSON.stringify({
            id: p.row.id,
            product_id: p.row.product_id,
            position: p.row.position,
            url: p.row.url,
            cloudinary_url: p.row.cloudinary_url,
            cloudinary_public_id: p.row.cloudinary_public_id,
            cloudinary_asset_id: p.row.cloudinary_asset_id,
          })
      )
        throw Error("referência de banco divergiu");
      entry.after = {
        public_id: after.public_id,
        asset_id: after.asset_id,
        version: after.version,
        version_id: after.version_id || changed.version_id,
        secure_url: after.secure_url,
        format: after.format,
        width: after.width,
        height: after.height,
        bytes: after.bytes,
        sha256: deliveredHash,
        derived_count: (after.derived || []).length,
        derived_bytes: (after.derived || []).reduce(
          (s, x) => s + Number(x.bytes || 0),
          0,
        ),
        persisted_url_checks: persistedAfter,
        unversioned,
        marketplaces: marketsAfter,
        tiny: tinyAfter,
      };
      entry.result = {
        savings_bytes: original.length - after.bytes,
        savings_percent: Number(
          (((original.length - after.bytes) * 100) / original.length).toFixed(
            2,
          ),
        ),
        cloudinary_ok: true,
        database_ok: true,
        mercado_livre_ok: marketsAfter.some(
          (x) => x.marketplace === "mercado_livre",
        )
          ? true
          : "N/A",
        shopee_ok: marketsAfter.some((x) => x.marketplace === "shopee")
          ? true
          : "N/A",
        tiny_ok: tinyAfter.status === "N/A" ? "N/A" : true,
        rollback_available: true,
      };
      entry.status = "APPROVED";
    } catch (error) {
      entry.failure = String(error.message || error);
      const restored = await restore(a, asset.asset_id, native.version_id);
      let rd = await detail(a, asset.asset_id);
      const rb = await req(
        `${rd.secure_url}?_rollback=${Date.now()}`,
        { cache: "no-store" },
        true,
      );
      entry.rollback = {
        performed: true,
        response: restored,
        sha256: sha256(rb),
        matches_original: sha256(rb) === originalHash,
      };
      entry.status = "ROLLED_BACK";
      throw error;
    }
    report.usage_after_each ||= [];
    report.usage_after_each.push({
      public_id: asset.public_id,
      usage: await usage(a),
    });
  }
  report.usage_after = await usage(a);
  report.status =
    report.assets.length === IDS.length &&
    report.assets.every((x) => x.status === "APPROVED")
      ? "APPROVED"
      : "BLOCKED";
  save();
  console.log(
    JSON.stringify(
      { output: OUT, status: report.status, processed: report.assets.length },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  report.status = "BLOCKED";
  report.failure = {
    phase: report.phase || "startup",
    public_id: report.current_public_id || null,
    source: error?.source || "internal",
    operation: error?.operation || "validation",
    http_status: Number(error?.http_status || 0) || null,
    method: error?.method || null,
    hostname: error?.hostname || null,
    message: safeMessage(error?.safe_message || error?.message || error),
  };
  delete report.current_public_id;
  save();
  console.error(`BLOQUEADO: ${JSON.stringify(report.failure)}`);
  process.exitCode = 1;
});
