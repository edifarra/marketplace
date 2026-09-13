import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { sha256 } from "../lib/cloudinary-legacy-optimize.mjs";
import {
  classifyInterruptedState,
  evaluateDatabaseReferences,
  INTERRUPTED_STATES,
} from "../lib/cloudinary-stage2-inspection.mjs";
import { mercadoLivreReadHeaders } from "../lib/cloudinary-stage2-pilot.mjs";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "artifacts", "cloudinary-stage2-batch");
const BACKUPS = path.join(OUT, "backups");
const manifest = JSON.parse(process.env.STAGE2C_INSPECTION_MANIFEST || "[]");
if (manifest.length !== 20)
  throw new Error("Inspeção exige o manifesto fixo de 20 assets.");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[match[1]] = value.replace(/\\n/g, "\n");
  }
}
const basic = (account) =>
  `Basic ${Buffer.from(`${account.key}:${account.secret}`).toString("base64")}`;
const safeMessage = (value) =>
  String(value || "falha externa")
    .replace(/(Basic|Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /(access_token|client_secret|api_key|signature|sign)=?[^\s&,]*/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 500);
async function req(url, options = {}, binary = false, context = {}) {
  const parsed = new URL(url),
    method = String(options.method || "GET").toUpperCase();
  const allowedTinyRead =
    method === "POST" &&
    parsed.hostname === "api.tiny.com.br" &&
    parsed.pathname === "/api2/produto.obter.php";
  if (method !== "GET" && !allowedTinyRead)
    throw new Error("método externo não permitido no modo somente leitura");
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(
      `${context.source || "external"}/${context.operation || "request"}: HTTP 0 ${parsed.hostname} ${error?.name === "TimeoutError" ? "timeout" : "network failure"}`,
    );
  }
  if (binary) {
    const data = Buffer.from(await response.arrayBuffer());
    if (!response.ok)
      throw new Error(
        `${context.source}/${context.operation}: HTTP ${response.status} ${parsed.hostname} ${safeMessage(response.headers.get("x-cld-error"))}`,
      );
    return data;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error)
    throw new Error(
      `${context.source}/${context.operation}: HTTP ${response.status} ${parsed.hostname} ${safeMessage(body?.error?.message || body?.message || body?.error)}`,
    );
  return body;
}
async function allRows(db, table, columns) {
  const result = [];
  for (let from = 0; ; from += 1000) {
    const response = await db
      .from(table)
      .select(columns)
      .range(from, from + 999);
    if (response.error) throw new Error(`${table}: ${response.error.message}`);
    result.push(...(response.data || []));
    if (!response.data || response.data.length < 1000) return result;
  }
}
async function optimize(buffer, format) {
  let pipeline = sharp(buffer, { failOn: "warning" }).rotate().resize({
    width: 1200,
    height: 1200,
    fit: "inside",
    withoutEnlargement: true,
  });
  return /png/i.test(format)
    ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : pipeline
        .jpeg({
          quality: 88,
          progressive: true,
          chromaSubsampling: "4:4:4",
          mozjpeg: true,
        })
        .toBuffer();
}
async function inspectUrl(url, source, operation) {
  const separator = url.includes("?") ? "&" : "?";
  const buffer = await req(
    `${url}${separator}_stage2c_inspect=${Date.now()}`,
    { cache: "no-store" },
    true,
    { source, operation },
  );
  const metadata = await sharp(buffer).metadata();
  return {
    url: url.split("?")[0],
    accessible: true,
    bytes: buffer.length,
    sha256: sha256(buffer),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    buffer,
  };
}
function shopeeUrl(account, itemId) {
  const api = "/api/v2/product/get_item_base_info",
    partner = String(account.client_id || process.env.SHOPEE_PARTNER_ID || ""),
    key = String(account.client_secret || process.env.SHOPEE_PARTNER_KEY || ""),
    shop = String(account.shop_id || account.account_id || ""),
    timestamp = Math.floor(Date.now() / 1000);
  if (!partner || !key || !shop || !account.access_token)
    throw new Error("Shopee sem credenciais de leitura");
  if (
    account.token_expires_at &&
    Date.parse(account.token_expires_at) <= Date.now()
  )
    throw new Error("token Shopee expirado; refresh proibido");
  const sign = crypto
    .createHmac("sha256", key)
    .update(`${partner}${api}${timestamp}${account.access_token}${shop}`)
    .digest("hex");
  return `https://partner.shopeemobile.com${api}?${new URLSearchParams({ partner_id: partner, timestamp: String(timestamp), sign, access_token: account.access_token, shop_id: shop, item_id_list: String(itemId) })}`;
}
async function marketplaceRead(link, accounts) {
  if (link.marketplace === "mercado_livre") {
    const body = await req(
      `https://api.mercadolibre.com/items/${encodeURIComponent(link.marketplace_product_id)}?attributes=id,status,pictures`,
      { headers: mercadoLivreReadHeaders(link, accounts) },
      false,
      { source: "mercado-livre", operation: "item-details" },
    );
    return {
      marketplace: link.marketplace,
      id: body.id,
      status: body.status,
      image_urls: (body.pictures || [])
        .map((item) => item.secure_url || item.url)
        .filter(Boolean),
    };
  }
  if (link.marketplace === "shopee") {
    const account = accounts.find(
      (item) => String(item.id) === String(link.marketplace_account_id),
    );
    if (!account) throw new Error("conta Shopee não encontrada");
    const body = await req(
      shopeeUrl(account, link.marketplace_product_id),
      {},
      false,
      { source: "shopee", operation: "item-base-info" },
    );
    const item = body.response?.item_list?.[0];
    if (!item) throw new Error("item Shopee não encontrado");
    return {
      marketplace: link.marketplace,
      id: String(item.item_id),
      status: item.item_status,
      image_urls: item.image?.image_url_list || [],
    };
  }
  return {
    marketplace: link.marketplace,
    id: link.marketplace_product_id,
    status: "READ_NOT_SUPPORTED",
    image_urls: [],
  };
}
async function tinyRead(product, token) {
  if (!product?.tiny_product_id) return null;
  if (!token) throw new Error("Tiny sem token de leitura");
  const body = new URLSearchParams({
    token,
    formato: "JSON",
    id: String(product.tiny_product_id),
  });
  const response = await req(
    "https://api.tiny.com.br/api2/produto.obter.php",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    false,
    { source: "tiny", operation: "product-details" },
  );
  const item = response.retorno?.produto;
  if (!item) throw new Error("produto Tiny não encontrado");
  return {
    marketplace: "tiny",
    id: String(product.tiny_product_id),
    status: item.situacao || "OK",
    image_urls: [],
  };
}
function backupFor(item) {
  if (!fs.existsSync(BACKUPS)) return null;
  const prefix = `${item.asset_id}__v${item.original_version}.`;
  const names = fs
    .readdirSync(BACKUPS)
    .filter((name) => name.startsWith(prefix));
  if (names.length !== 1) return names.length ? { ambiguous: names } : null;
  return { path: path.join(BACKUPS, names[0]), filename: names[0] };
}
loadEnv(path.join(ROOT, ".env.local"));
loadEnv(path.join(ROOT, ".env.vercel.local"));
const dbKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !dbKey)
  throw new Error("Supabase sem credenciais de leitura.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, dbKey, {
  auth: { persistSession: false },
});
const [images, products, links, listings, accounts, settingsResponse] =
  await Promise.all([
    allRows(
      db,
      "product_images",
      "id,product_id,position,status,url,cloudinary_url,cloudinary_public_id,cloudinary_cloud_name,cloudinary_asset_id,bytes,width_px,height_px",
    ),
    allRows(db, "products", "id,sku,status,tiny_product_id"),
    allRows(
      db,
      "product_marketplaces",
      "id,product_id,marketplace,marketplace_account_id,marketplace_product_id,status_anuncio,raw_data",
    ),
    allRows(
      db,
      "listings",
      "id,product_id,marketplace,external_listing_id,external_sku,status",
    ),
    allRows(
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
if (settingsResponse.error) throw new Error(settingsResponse.error.message);
const settings = new Map(
  (settingsResponse.data || []).map((item) => [
    item.key,
    String(item.value || ""),
  ]),
);
const cloudinary = {
  cloud: settings.get("CLOUDINARY_CLOUD_NAME"),
  key: settings.get("CLOUDINARY_API_KEY"),
  secret: settings.get("CLOUDINARY_API_SECRET"),
};
const report = {
  mode: "inspect-interrupted-stage2c",
  strictly_read_only: true,
  started_at: new Date().toISOString(),
  total: 20,
  database_writes: 0,
  marketplace_writes: 0,
  cloudinary_writes: 0,
  preflight_snapshot_comparison:
    "indisponível: execução interrompida não gerou report.json",
  assets: [],
};

for (const [index, item] of manifest.entries()) {
  console.log(`[INSPECT ${index + 1}/20] ${item.public_id}`);
  const entry = {
    position: `${index + 1}/20`,
    public_id: item.public_id,
    asset_id: item.asset_id,
    original_version: item.original_version,
    state: INTERRUPTED_STATES.OVERWRITTEN_NEEDS_REVIEW,
    evidence: [],
    errors: [],
  };
  const backup = backupFor(item);
  let expectedBuffer;
  try {
    if (backup?.ambiguous)
      entry.errors.push(
        `mais de um backup externo: ${backup.ambiguous.join(", ")}`,
      );
    if (backup?.path) {
      const backupBuffer = fs.readFileSync(backup.path);
      const metadata = await sharp(backupBuffer).metadata();
      expectedBuffer = await optimize(backupBuffer, metadata.format);
      entry.external_backup = {
        exists: true,
        filename: backup.filename,
        sha256: sha256(backupBuffer),
        bytes: backupBuffer.length,
      };
      entry.expected_optimized = {
        sha256: sha256(expectedBuffer),
        bytes: expectedBuffer.length,
      };
    } else entry.external_backup = { exists: false };
  } catch (error) {
    entry.external_backup = { exists: Boolean(backup?.path) };
    entry.errors.push(`backup externo: ${safeMessage(error?.message)}`);
  }
  try {
    const detail = await req(
      `https://api.cloudinary.com/v1_1/${cloudinary.cloud}/resources/${encodeURIComponent(item.asset_id)}?versions=true&max_results=100`,
      { headers: { Authorization: basic(cloudinary) } },
      false,
      { source: "cloudinary", operation: "asset-details" },
    );
    const current = await inspectUrl(
      detail.secure_url,
      "cloudinary",
      "current-download",
    );
    entry.current_version = Number(detail.version);
    entry.current = {
      bytes: current.bytes,
      sha256: current.sha256,
      width: current.width,
      height: current.height,
      format: current.format,
      url_accessible: true,
    };
    entry.identity = {
      same_asset_id: detail.asset_id === item.asset_id,
      same_public_id: detail.public_id === item.public_id,
    };
    entry.native_backup = {
      exists:
        Array.isArray(detail.versions) &&
        detail.versions.some(
          (version) =>
            version.version_id &&
            Number(version.version) === Number(item.original_version) &&
            version.restorable !== false,
        ),
      versions: (detail.versions || []).map((version) => ({
        version: version.version,
        version_id: version.version_id,
        bytes: version.bytes,
        restorable: version.restorable,
      })),
    };
    const databaseAssessment = evaluateDatabaseReferences({
      expected: item,
      imageRows: images,
      products,
      marketplaceLinks: links,
      listings,
    });
    const imageRows = databaseAssessment.matchedRows;
    entry.database = {
      state: databaseAssessment.state,
      reason: databaseAssessment.reason,
      identity_consistent: databaseAssessment.state === "CONSISTENT",
      references: databaseAssessment.references,
      tables: databaseAssessment.tables,
      writes_observed: false,
      comparison_with_interrupted_preflight:
        "indisponível: report.json não existe",
    };
    const persistedUrls = [
      ...new Set(
        imageRows
          .flatMap((row) => [row.url, row.cloudinary_url])
          .filter(Boolean),
      ),
    ];
    entry.persisted_urls = [];
    for (const url of persistedUrls) {
      const check = await inspectUrl(
        url,
        "persisted-image",
        "inspection-download",
      );
      entry.persisted_urls.push({
        url: check.url,
        accessible: true,
        bytes: check.bytes,
        sha256: check.sha256,
      });
    }
    const productIds = new Set(imageRows.map((row) => String(row.product_id)));
    entry.marketplaces = [];
    const optimizedEvidence = (detail.versions || []).some(
      (version) =>
        Number(version.version) > Number(item.original_version) &&
        expectedBuffer &&
        Number(version.bytes) === expectedBuffer.length,
    );
    const overwriteEvidence =
      Number(entry.current_version) > Number(item.original_version) ||
      (Boolean(backup?.path) &&
        current.sha256 !== entry.external_backup.sha256) ||
      optimizedEvidence;
    if (overwriteEvidence) {
      for (const link of links.filter(
        (link) =>
          productIds.has(String(link.product_id)) &&
          ["mercado_livre", "shopee"].includes(link.marketplace),
      )) {
        try {
          entry.marketplaces.push(await marketplaceRead(link, accounts));
        } catch (error) {
          entry.errors.push(safeMessage(error?.message));
        }
      }
      for (const product of products.filter((product) =>
        productIds.has(String(product.id)),
      )) {
        try {
          const snapshot = await tinyRead(product, settings.get("TINY_TOKEN"));
          if (snapshot) entry.marketplaces.push(snapshot);
        } catch (error) {
          entry.errors.push(safeMessage(error?.message));
        }
      }
    }
    entry.marketplace_read_only = true;
    const readValidationOk =
      entry.database.identity_consistent &&
      entry.persisted_urls.length > 0 &&
      entry.persisted_urls.every((check) => check.accessible) &&
      entry.errors.length === 0 &&
      entry.marketplaces.every(
        (snapshot) => snapshot.status !== "READ_NOT_SUPPORTED",
      );
    entry.state = classifyInterruptedState({
      identityOk: entry.identity.same_asset_id && entry.identity.same_public_id,
      originalVersion: item.original_version,
      currentVersion: entry.current_version,
      backupExists: Boolean(backup?.path),
      backupSha256: entry.external_backup.sha256,
      currentSha256: current.sha256,
      expectedSha256: entry.expected_optimized?.sha256,
      optimizedEvidence,
      optimizedOutputValid:
        Math.max(current.width || 0, current.height || 0) <= 1200,
      readValidationOk,
    });
    entry.evidence.push(
      `versão atual ${entry.current_version}; versão original ${item.original_version}`,
      backup?.path
        ? "backup externo conferido por SHA-256"
        : "backup externo ausente",
      `bytes atuais ${current.bytes}`,
    );
  } catch (error) {
    entry.errors.push(safeMessage(error?.message));
  }
  report.assets.push(entry);
}

report.counts = Object.fromEntries(
  Object.values(INTERRUPTED_STATES).map((state) => [
    state,
    report.assets.filter((asset) => asset.state === state).length,
  ]),
);
report.finished_at = new Date().toISOString();
report.status = report.counts.OVERWRITTEN_NEEDS_REVIEW
  ? "REVIEW_REQUIRED"
  : "PASS";
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, "interrupted-inspection.json"),
  JSON.stringify(report, null, 2),
);
const lines = [
  "# Inspeção somente leitura — Cloudinary Stage 2C interrompida",
  "",
  `- Total: ${report.total}`,
  `- NOT_STARTED: ${report.counts.NOT_STARTED}`,
  `- Somente com backup: ${report.counts.BACKUP_CREATED_NOT_OVERWRITTEN}`,
  `- Sobrescritos e válidos: ${report.counts.OVERWRITTEN_AND_VALID}`,
  `- Precisam revisão: ${report.counts.OVERWRITTEN_NEEDS_REVIEW}`,
  `- Rollback: ${report.counts.ROLLED_BACK}`,
  "",
  "> Esta inspeção não executou escrita em Cloudinary, Supabase ou marketplaces.",
  "",
];
for (const asset of report.assets)
  lines.push(
    `## ${asset.position} — ${asset.public_id}`,
    "",
    `- Estado: **${asset.state}**`,
    `- Asset ID: ${asset.asset_id}`,
    `- Versão original / atual: ${asset.original_version} / ${asset.current_version ?? "indisponível"}`,
    `- Backup externo: ${asset.external_backup?.exists ? `sim (${asset.external_backup.bytes} bytes; SHA-256 ${asset.external_backup.sha256})` : "não"}`,
    `- Tamanho atual: ${asset.current?.bytes ?? "indisponível"}`,
    `- Dimensões/formato atuais: ${asset.current ? `${asset.current.width}×${asset.current.height} ${asset.current.format}` : "indisponível"}`,
    `- Backup nativo: ${asset.native_backup?.exists ? "sim" : "não comprovado"}`,
    `- Identidade preservada: ${asset.identity?.same_asset_id && asset.identity?.same_public_id ? "sim" : "não comprovado"}`,
    `- URL atual acessível: ${asset.current?.url_accessible ? "sim" : "não comprovado"}`,
    `- URLs persistidas acessíveis: ${asset.persisted_urls?.length && asset.persisted_urls.every((item) => item.accessible) ? `sim (${asset.persisted_urls.length})` : "não comprovado"}`,
    `- Referências do banco: ${asset.database?.state || "NOT_PROVABLE"} — ${asset.database?.reason || "falha de consulta"}`,
    `- Consultas de marketplace: ${asset.marketplaces?.length ?? 0} (somente leitura)`,
    ...(asset.errors.length ? [`- Erros: ${asset.errors.join("; ")}`] : []),
    "",
  );
fs.writeFileSync(
  path.join(OUT, "interrupted-inspection.md"),
  `${lines.join("\n")}\n`,
);
console.log(
  `PASS: inspeção somente leitura concluída; ${report.counts.OVERWRITTEN_NEEDS_REVIEW} asset(s) precisam revisão.`,
);
