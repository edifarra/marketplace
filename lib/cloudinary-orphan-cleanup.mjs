import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export const CLASSIFICATIONS = Object.freeze({
  SAFE: "SEGURO_PARA_EXCLUIR",
  REFERENCE: "REFERENCIA_ATUAL",
  EXPIRED: "TOKEN_EXPIRADO",
  UNAVAILABLE: "FONTE_INACESSIVEL",
  UNCERTAIN: "INCERTO",
  ERROR: "ERRO_VALIDACAO"
});

const ACTIVE_STATUSES = /^(active|paused|draft|pending|ready|publishing|queued|retry|processing|received|running|open)$/i;
const SECRET_KEYS = /(?:token|secret|authorization|partner[_-]?key|service[_-]?role|api[_-]?key|signature|sign$)/i;
const GROUPS = new Set(["SEM_ASSOCIACAO_LOCAL", "SOMENTE_TINY", "ML_E_TINY"]);
const REQUIRED_TABLES = [
  "product_images", "product_marketplace_variations", "product_marketplaces", "listings",
  "marketplace_activities", "marketplace_activity_history", "outgoing_marketplace_activities",
  "outgoing_marketplace_activity_history", "marketplace_conversations",
  "marketplace_conversation_messages", "settings"
];
const HTTP_TIMEOUT_MS = 15_000;
const MAX_HTTP_RETRIES = 1;

export function parseCleanupArgs(argv) {
  const execute = argv.includes("--execute");
  if (execute && argv.includes("--dry-run")) throw new Error("Use somente um modo: --dry-run ou --execute.");
  const raw = argv.find(value => value.startsWith("--limit="))?.slice(8);
  const limit = raw === undefined ? 100 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit deve ser um inteiro entre 1 e 500.");
  const unknown = argv.filter(value => !["--dry-run", "--execute"].includes(value) && !value.startsWith("--limit="));
  if (unknown.length) throw new Error(`Argumento desconhecido: ${unknown[0]}`);
  return { mode: execute ? "execute" : "dry-run", limit };
}

export function loadCleanupEnv(root, env = process.env) {
  const envFile = path.join(root, ".env.local");
  if (!fs.existsSync(envFile)) return env;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value.replace(/\\n/g, "\n");
  }
  return env;
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? "[REDACTED]" : redactSecrets(item)]));
}

export function safeError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const message = error instanceof Error ? error.message : String(error || "erro desconhecido");
  return `${status ? `HTTP ${status}: ` : ""}${message}`
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|token|sign|signature|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:eyJ|shp_|APP_USR-)[A-Za-z0-9._-]{12,}\b/g, "[REDACTED]");
}

function transientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchWithPolicy(url, options = {}, { source = "HTTP", timeoutMs = HTTP_TIMEOUT_MS, retries = MAX_HTTP_RETRIES, fetchImpl = fetch, diagnostics, logger = () => {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error(`timeout de ${timeoutMs}ms`)), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
    try {
      const response = await fetchImpl(url, { ...options, signal });
      if (transientHttpStatus(response.status) && attempt < retries) {
        logger(`${source}: falha transitória HTTP ${response.status}; retry ${attempt + 1}/${retries}.`);
        continue;
      }
      return response;
    } catch (error) {
      const timedOut = timeoutController.signal.aborted;
      lastError = new Error(timedOut ? `${source}: timeout após ${timeoutMs}ms` : `${source}: ${safeError(error)}`);
      lastError.source = source;
      lastError.timeout = timedOut;
      if (timedOut && diagnostics) diagnostics.timeoutsBySource[source] = (diagnostics.timeoutsBySource[source] || 0) + 1;
      if (attempt >= retries) throw lastError;
      logger(`${source}: ${timedOut ? "timeout" : "falha transitória"}; retry ${attempt + 1}/${retries}.`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function processCandidateBatch(candidates, handler, onError = () => {}) {
  const results = [];
  for (const candidate of candidates) {
    try { results.push(await handler(candidate)); }
    catch (error) { onError(candidate, error); results.push(undefined); }
  }
  return results;
}

const normalize = value => String(value || "").trim().toUpperCase();
const skuFromAsset = asset => normalize(String(asset.public_id || "").replace(/^[^:]+::/, "").split("/").at(-1)?.split("_")[0]);
const withoutCloud = value => String(value || "").replace(/^[^:]+::/, "");
const activeRow = row => row.existe_no_marketplace === true || ACTIVE_STATUSES.test(String(row.status || row.status_anuncio || row.external_status || ""));
const operationalRow = (table, row) => {
  if (table === "product_images" || table === "settings" || table === "product_marketplace_variations") return true;
  if (table.includes("history")) return false;
  return activeRow(row);
};

export function candidateTerms(asset) {
  const publicId = withoutCloud(asset.public_id).replace(/\.(jpe?g|png|webp|avif)$/i, "");
  const filename = publicId.split("/").at(-1) || "";
  const url = String(asset.secure_url || "");
  const unversioned = url.replace(/\/v\d+\//, "/");
  const derivedUrls = (asset.derived || []).flatMap(item => [item.secure_url, item.url]).filter(Boolean);
  return [...new Set([asset.asset_id, publicId, url, unversioned, filename.length >= 12 ? filename : "", ...derivedUrls].filter(Boolean).map(value => String(value).toLowerCase()))];
}

function containsTerms(value, terms) {
  const text = (typeof value === "string" ? value : JSON.stringify(value || {})).toLowerCase();
  return terms.some(term => text.includes(term));
}

export function classifyCandidate(asset, evidence) {
  const base = { ...asset, evidencias: evidence.notes || [] };
  if (evidence.currentReferences?.length) return { ...base, classificacao: CLASSIFICATIONS.REFERENCE, motivo: "Referência operacional atual encontrada." };
  if (evidence.errors?.length) return { ...base, classificacao: CLASSIFICATIONS.ERROR, motivo: evidence.errors.join("; ") };
  if (evidence.expired?.length) return { ...base, classificacao: CLASSIFICATIONS.EXPIRED, motivo: evidence.expired.join("; ") };
  if (evidence.unavailable?.length) return { ...base, classificacao: CLASSIFICATIONS.UNAVAILABLE, motivo: evidence.unavailable.join("; ") };
  if (!evidence.complete) return { ...base, classificacao: CLASSIFICATIONS.UNCERTAIN, motivo: "Validação obrigatória incompleta." };
  return { ...base, classificacao: CLASSIFICATIONS.SAFE, motivo: "Todas as fontes obrigatórias foram consultadas sem referência operacional atual." };
}

export function requiredSourcesForCandidate(asset) {
  const marketplaces = new Set(asset.current_marketplaces || []);
  const required = new Set();
  if (asset.grupo === "ML_E_TINY" || marketplaces.has("mercado_livre")) required.add("mercado_livre");
  if (marketplaces.has("shopee")) required.add("shopee");
  if (asset.grupo === "SOMENTE_TINY" || asset.grupo === "ML_E_TINY") required.add("tiny");
  return required;
}

export function applyRequiredSourceFailures(asset, evidence, source, failures) {
  if (!requiredSourcesForCandidate(asset).has(source)) return;
  for (const failure of failures) evidence[failure.type === "expired" ? "expired" : "unavailable"].push(failure.reason);
}

async function allRows(db, table, columns = "*") {
  const rows = [];
  for (let from = 0;; from += 1000) {
    const { data, error } = await db.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

async function apiJson(url, options = {}, policy = {}) {
  const response = await fetchWithPolicy(url, options, policy);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    const error = new Error(`falha na consulta somente leitura (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function validAccount(account) {
  if (!account.access_token) return { ok: false, type: "unavailable", reason: `${account.marketplace}: token ausente na conta ${account.id}` };
  if (account.token_expires_at && Date.parse(account.token_expires_at) <= Date.now()) return { ok: false, type: "expired", reason: `${account.marketplace}: token expirado na conta ${account.id}` };
  return { ok: true };
}

async function scanMercadoLivre(accounts, targetSkus, context) {
  const found = new Set();
  const cloudinaryReferences = new Set();
  const independentCopies = new Set();
  const failures = [];
  if (!targetSkus.size) return { found, cloudinaryReferences, independentCopies, failures };
  for (const account of accounts.filter(item => item.marketplace === "mercado_livre" && item.active !== false)) {
    const validity = validAccount(account);
    if (!validity.ok) { failures.push(validity); continue; }
    const seller = account.seller_id || account.account_id;
    if (!seller) { failures.push({ type: "unavailable", reason: `mercado_livre: seller_id ausente na conta ${account.id}` }); continue; }
    try {
      let scrollId = "";
      do {
        const query = new URLSearchParams({ search_type: "scan", limit: "100", ...(scrollId ? { scroll_id: scrollId } : {}) });
        context.logger(`Mercado Livre: consultando inventário da conta ${account.id}.`);
        const page = await apiJson(`https://api.mercadolibre.com/users/${encodeURIComponent(seller)}/items/search?${query}`, { headers: { Authorization: `Bearer ${account.access_token}` } }, { ...context, source: "Mercado Livre" });
        const ids = page.results || [];
        for (let i = 0; i < ids.length; i += 20) {
          const bulk = await apiJson(`https://api.mercadolibre.com/items?ids=${encodeURIComponent(ids.slice(i, i + 20).join(","))}&attributes=id,status,pictures,variations,seller_custom_field,attributes`, { headers: { Authorization: `Bearer ${account.access_token}` } }, { ...context, source: "Mercado Livre" });
          for (const entry of bulk || []) {
            const item = entry.body || {};
            const text = JSON.stringify({ seller_custom_field: item.seller_custom_field, variations: item.variations, attributes: item.attributes }).toUpperCase();
            const pictureText = JSON.stringify(item.pictures || []).toLowerCase();
            const pictureUrls = (item.pictures || []).flatMap(picture => [picture.url, picture.secure_url]).filter(Boolean);
            for (const sku of targetSkus) if (sku && text.includes(sku)) {
              found.add(sku);
              if (pictureText.includes("res.cloudinary.com")) cloudinaryReferences.add(sku);
              if (pictureUrls.length && pictureUrls.every(url => { try { return /(^|\.)mlstatic\.com$/i.test(new URL(url).hostname); } catch { return false; } })) independentCopies.add(sku);
            }
          }
        }
        scrollId = page.scroll_id || "";
        if (!ids.length) break;
      } while (scrollId);
    } catch (error) { failures.push({ type: Number(error?.status) === 401 ? "expired" : "unavailable", reason: `mercado_livre: ${safeError(error)}` }); }
  }
  if (!accounts.some(item => item.marketplace === "mercado_livre" && item.active !== false)) failures.push({ type: "unavailable", reason: "mercado_livre: nenhuma conta ativa acessível" });
  return { found, cloudinaryReferences, independentCopies, failures };
}

function shopeeSignedUrl(account, apiPath, extra = {}) {
  const partnerId = String(account.client_id || process.env.SHOPEE_PARTNER_ID || "");
  const partnerKey = String(account.client_secret || process.env.SHOPEE_PARTNER_KEY || "");
  const shopId = String(account.shop_id || account.account_id || "");
  if (!partnerId || !partnerKey || !shopId) throw new Error("credenciais de assinatura incompletas");
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHmac("sha256", partnerKey).update(`${partnerId}${apiPath}${timestamp}${account.access_token}${shopId}`).digest("hex");
  const query = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign, access_token: account.access_token, shop_id: shopId, ...extra });
  return `https://partner.shopeemobile.com${apiPath}?${query}`;
}

async function scanShopee(accounts, targetSkus, context) {
  const found = new Set();
  const failures = [];
  if (!targetSkus.size) return { found, failures };
  for (const account of accounts.filter(item => item.marketplace === "shopee" && item.active !== false)) {
    const validity = validAccount(account);
    if (!validity.ok) { failures.push(validity); continue; }
    try {
      for (const itemStatus of ["NORMAL", "UNLIST"]) {
       let offset = 0;
       while (true) {
        const listPath = "/api/v2/product/get_item_list";
        context.logger(`Shopee: consultando inventário da conta ${account.id}.`);
        const page = await apiJson(shopeeSignedUrl(account, listPath, { offset: String(offset), page_size: "100", item_status: itemStatus }), {}, { ...context, source: "Shopee" });
        const ids = (page.response?.item || []).map(item => item.item_id);
        for (let i = 0; i < ids.length; i += 50) {
          const detailPath = "/api/v2/product/get_item_base_info";
          const body = await apiJson(shopeeSignedUrl(account, detailPath, { item_id_list: ids.slice(i, i + 50).join(",") }), {}, { ...context, source: "Shopee" });
          for (const item of body.response?.item_list || []) {
            const text = JSON.stringify({ item_sku: item.item_sku, model: item.model }).toUpperCase();
            for (const sku of targetSkus) if (sku && text.includes(sku)) found.add(sku);
          }
        }
        if (!page.response?.has_next_page) break;
        offset += ids.length;
        if (!ids.length) break;
       }
      }
    } catch (error) { failures.push({ type: "unavailable", reason: `shopee: ${safeError(error)}` }); }
  }
  if (!accounts.some(item => item.marketplace === "shopee" && item.active !== false)) failures.push({ type: "unavailable", reason: "shopee: nenhuma conta ativa acessível" });
  return { found, failures };
}

async function tinyProduct(id, token, context) {
  const body = new URLSearchParams({ token, formato: "JSON", id: String(id) });
  const response = await fetchWithPolicy("https://api.tiny.com.br/api2/produto.obter.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { ...context, source: "Tiny" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || String(json.retorno?.status || "").toLowerCase() === "erro") throw new Error(`Tiny indisponível (${response.status})`);
  return json.retorno?.produto || {};
}

function groupCandidates(candidates, fullById, products, links, listings) {
  const productBySku = new Map(products.map(item => [normalize(item.sku), item]));
  const productById = new Map(products.map(item => [String(item.id), item]));
  const destinations = new Map();
  for (const item of [...links, ...listings].filter(activeRow)) {
    const sku = normalize(item.sku || item.external_sku || productById.get(String(item.product_id || ""))?.sku);
    if (!sku) continue;
    if (!destinations.has(sku)) destinations.set(sku, new Set());
    destinations.get(sku).add(item.marketplace);
  }
  return candidates.map(candidate => {
    const full = fullById.get(candidate.asset_id) || {};
    const sku = skuFromAsset(candidate);
    const product = productBySku.get(sku);
    const markets = destinations.get(sku) || new Set();
    const ml = markets.has("mercado_livre"), shopee = markets.has("shopee"), tiny = Boolean(product?.tiny_product_id);
    const grupo = GROUPS.has(candidate.grupo) ? candidate.grupo : "FORA_DO_ESCOPO";
    const secureUrl = full.secure_url || candidate.secure_url || "";
    return { ...candidate, cloud_name: candidate.cloud_name || String(secureUrl).match(/res\.cloudinary\.com\/([^/]+)/i)?.[1] || "", secure_url: secureUrl, width: full.width, height: full.height, derived: full.derived || [], sku, product_id: product?.id || null, tiny_product_id: product?.tiny_product_id || null, grupo, current_marketplaces: [...markets], current_tiny: tiny };
  });
}

async function validate(root, limit, logger) {
  const startedAt = Date.now();
  const diagnostics = { timeoutsBySource: {} };
  const httpContext = { diagnostics, logger };
  loadCleanupEnv(root);
  logger(`SUPABASE_SERVICE_ROLE_KEY: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "PRESENTE" : "AUSENTE"}`);
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("FONTE_INACESSIVEL: Supabase backend não configurado.");
  const auditDir = path.join(root, "artifacts", "cloudinary-legacy-audit");
  const manifestPath = path.join(root, "scripts", "data", "cloudinary-orphan-stage-1-candidates.json");
  const candidates = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestGroups = Object.fromEntries([...GROUPS].map(group => [group, candidates.filter(item => item.grupo === group).length]));
  if (candidates.length !== 111 || manifestGroups.SEM_ASSOCIACAO_LOCAL !== 76 || manifestGroups.SOMENTE_TINY !== 28 || manifestGroups.ML_E_TINY !== 7) throw new Error(`INCERTO: manifesto inválido (${candidates.length} candidatos).`);
  const fullById = new Map(candidates.map(item => [item.asset_id, item]));
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: (url, options) => fetchWithPolicy(url, options, { ...httpContext, source: "Supabase" }) } });
  logger("Supabase: carregando associações e credenciais de validação.");
  const [products, links, listings, accounts] = await Promise.all([
    allRows(db, "products", "id,sku,status,tiny_product_id"), allRows(db, "product_marketplaces", "*"),
    allRows(db, "listings", "*"), allRows(db, "config_marketplace_accounts", "*")
  ]);
  const grouped = groupCandidates(candidates, fullById, products, links, listings);
  const protectedCount = 282;
  const entireStage = grouped.filter(item => GROUPS.has(item.grupo));
  if (entireStage.length !== 111) throw new Error(`INCERTO: drift de escopo (${entireStage.length} candidatos válidos).`);
  const stage = entireStage.slice(0, limit);
  const evidence = new Map(stage.map(item => [item.asset_id, { complete: false, notes: [], currentReferences: [], expired: [], unavailable: [], errors: [] }]));
  stage.forEach((asset, index) => logger(`[${index + 1}/${stage.length}] ${asset.sku} | fontes: Supabase${requiredSourcesForCandidate(asset).has("tiny") ? " / Tiny" : ""}${requiredSourcesForCandidate(asset).has("mercado_livre") ? " / Mercado Livre" : ""}${requiredSourcesForCandidate(asset).has("shopee") ? " / Shopee" : ""}.`));
  for (const asset of stage) {
    const item = evidence.get(asset.asset_id);
    const markets = new Set(asset.current_marketplaces);
    if (asset.grupo === "SEM_ASSOCIACAO_LOCAL" && (markets.size || asset.current_tiny)) item.currentReferences.push({ fonte: "associação local atual", marketplaces: [...markets], tiny: asset.current_tiny });
    if (asset.grupo === "SOMENTE_TINY" && (markets.has("mercado_livre") || markets.has("shopee"))) item.currentReferences.push({ fonte: "associação marketplace atual", marketplaces: [...markets] });
    if (asset.grupo === "ML_E_TINY" && markets.has("shopee")) item.currentReferences.push({ fonte: "associação Shopee atual" });
    if (asset.grupo !== "SEM_ASSOCIACAO_LOCAL" && !asset.tiny_product_id) item.unavailable.push("Tiny: tiny_product_id atual não encontrado");
  }
  const priorScanFile = path.join(auditDir, "final-validation-database-scan.json");
  const priorTables = fs.existsSync(priorScanFile)
    ? (JSON.parse(fs.readFileSync(priorScanFile, "utf8")).table_stats || []).filter(item => !item.error).map(item => item.table)
    : [];
  const tablesToScan = [...new Set([...REQUIRED_TABLES, ...priorTables])].filter(table => /^[a-z_][a-z0-9_]*$/i.test(table));
  let variationRows = [];
  for (const table of tablesToScan) {
    try {
      logger(`Supabase: validando referências em ${table}.`);
      const rows = await allRows(db, table, "*");
      if (table === "product_marketplace_variations") variationRows = rows;
      for (const asset of stage) {
        const terms = candidateTerms(asset);
        for (const row of rows) if (containsTerms(row, terms) && operationalRow(table, row)) evidence.get(asset.asset_id).currentReferences.push({ fonte: table });
      }
    } catch (error) {
      for (const item of evidence.values()) item.unavailable.push(`${table}: ${safeError(error)}`);
    }
  }
  for (const asset of stage.filter(item => item.grupo === "SEM_ASSOCIACAO_LOCAL")) {
    if (variationRows.some(row => normalize(row.sku) === asset.sku && activeRow(row))) evidence.get(asset.asset_id).currentReferences.push({ fonte: "product_marketplace_variations", sku: asset.sku });
  }
  const mlSkus = new Set(stage.filter(item => requiredSourcesForCandidate(item).has("mercado_livre")).map(item => item.sku).filter(Boolean));
  const shopeeSkus = new Set(stage.filter(item => requiredSourcesForCandidate(item).has("shopee")).map(item => item.sku).filter(Boolean));
  const [ml, shopee] = await Promise.all([scanMercadoLivre(accounts, mlSkus, httpContext), scanShopee(accounts, shopeeSkus, httpContext)]);
  for (const asset of stage) {
    const item = evidence.get(asset.asset_id);
    const required = requiredSourcesForCandidate(asset);
    if (required.has("mercado_livre")) {
      if (ml.cloudinaryReferences.has(asset.sku)) item.currentReferences.push({ fonte: "Mercado Livre", sku: asset.sku, motivo: "imagem Cloudinary no anúncio" });
      else if (asset.grupo === "ML_E_TINY" && ml.found.has(asset.sku) && !ml.independentCopies.has(asset.sku)) item.unavailable.push(`Mercado Livre: não foi possível provar cópia independente para ${asset.sku}`);
      else if (asset.grupo === "ML_E_TINY" && ml.independentCopies.has(asset.sku)) item.notes.push("Mercado Livre usa exclusivamente imagens do CDN mlstatic.");
    }
    if (required.has("shopee") && shopee.found.has(asset.sku)) item.currentReferences.push({ fonte: "Shopee", sku: asset.sku });
    applyRequiredSourceFailures(asset, item, "mercado_livre", ml.failures);
    applyRequiredSourceFailures(asset, item, "shopee", shopee.failures);
  }
  const tinyToken = process.env.TINY_TOKEN || String((await allRows(db, "settings", "key,value")).find(item => /tiny.*token/i.test(item.key))?.value || "");
  const tinyCache = new Map();
  await processCandidateBatch(stage.filter(item => requiredSourcesForCandidate(item).has("tiny") && item.tiny_product_id), async asset => {
      const item = evidence.get(asset.asset_id);
      if (!tinyToken) { item.unavailable.push("Tiny: token ausente"); return; }
      logger(`Tiny: validando [${stage.indexOf(asset) + 1}/${stage.length}] ${asset.sku}.`);
      if (!tinyCache.has(asset.tiny_product_id)) tinyCache.set(asset.tiny_product_id, await tinyProduct(asset.tiny_product_id, tinyToken, httpContext));
      if (containsTerms(tinyCache.get(asset.tiny_product_id), candidateTerms(asset))) item.currentReferences.push({ fonte: "Tiny", produto: String(asset.tiny_product_id) });
      else item.notes.push("Tiny consultado por produto.obter.php sem referência ao asset.");
    }, (asset, error) => evidence.get(asset.asset_id).unavailable.push(`Tiny: ${safeError(error)}`));
  for (const item of evidence.values()) item.complete = !item.currentReferences.length && !item.expired.length && !item.unavailable.length && !item.errors.length;
  const classified = [];
  for (const [index, asset] of stage.entries()) {
    const result = classifyCandidate(asset, evidence.get(asset.asset_id));
    classified.push(result);
    logger(`[${index + 1}/${stage.length}] ${asset.sku} | classificação: ${result.classificacao}.`);
    if ((index + 1) % 10 === 0 || index + 1 === stage.length) {
      const approved = classified.filter(item => item.classificacao === CLASSIFICATIONS.SAFE).length;
      const errors = classified.filter(item => item.classificacao === CLASSIFICATIONS.ERROR).length;
      logger(`Resumo parcial: processados=${index + 1}; aprovados=${approved}; bloqueados=${classified.length - approved}; erros=${errors}; decorrido=${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
    }
  }
  return { auditDir, protectedCount, stage, classified, diagnostics, durationMs: Date.now() - startedAt };
}

async function cloudinaryDestroy(asset, context = {}) {
  const cloudName = asset.cloud_name || String(asset.secure_url).match(/res\.cloudinary\.com\/([^/]+)/i)?.[1] || process.env.CLOUDINARY_CLOUD_NAME;
  const publicId = withoutCloud(asset.public_id);
  if (!cloudName || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) throw new Error("Credenciais Cloudinary indisponíveis.");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHash("sha1").update(`invalidate=true&public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`).digest("hex");
  const form = new URLSearchParams({ public_id: publicId, invalidate: "true", timestamp, api_key: process.env.CLOUDINARY_API_KEY, signature });
  context.logger?.(`Cloudinary: excluindo ${asset.public_id}.`);
  const result = await apiJson(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }, { ...context, source: "Cloudinary" });
  if (result.result !== "ok" && result.result !== "not found") throw new Error(`Cloudinary não confirmou exclusão: ${result.result || "sem resultado"}`);
  try {
    const auth = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString("base64");
    await apiJson(`https://api.cloudinary.com/v1_1/${cloudName}/resources/${encodeURIComponent(asset.asset_id)}`, { headers: { Authorization: `Basic ${auth}` } }, { ...context, source: "Cloudinary" });
    throw new Error("Asset ainda existe após destroy.");
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
  }
  return { result: "deleted", confirmed_absent: true };
}

export async function executeApproved(approved, destroy = cloudinaryDestroy, context = {}) {
  const executed = [], errors = [];
  for (const asset of approved) {
    if (asset.classificacao !== CLASSIFICATIONS.SAFE) { errors.push({ asset_id: asset.asset_id, erro: "Classificação não autorizada." }); continue; }
    try { executed.push({ ...asset, ...(await destroy(asset, context)), executed_at: new Date().toISOString() }); }
    catch (error) { errors.push({ asset_id: asset.asset_id, public_id: asset.public_id, erro: safeError(error) }); }
  }
  return { executed, errors };
}

const bytes = (items, key) => items.reduce((sum, item) => sum + Number(item[key] || 0), 0);
const mb = value => (value / 1024 / 1024).toFixed(2);

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(redactSecrets(value), null, 2)); }

export async function runCleanup({ root = process.cwd(), mode = "dry-run", limit = 100, logger = console.log, validateFn = validate, destroyFn = cloudinaryDestroy } = {}) {
  const runStartedAt = Date.now();
  const first = await validateFn(root, limit, logger);
  const validationResult = mode === "execute" ? await validateFn(root, limit, logger) : first;
  const classified = validationResult.classified;
  const approved = classified.filter(item => item.classificacao === CLASSIFICATIONS.SAFE);
  const blocked = classified.filter(item => item.classificacao !== CLASSIFICATIONS.SAFE);
  logger(`Pré-exclusão: aprovados=${approved.length}; bloqueados=${blocked.length}; MB aprovados=${mb(bytes(approved, "bytes") + bytes(approved, "derived_bytes"))}`);
  let executed = [], errors = [];
  if (mode === "execute") ({ executed, errors } = await executeApproved(approved, destroyFn, { diagnostics: validationResult.diagnostics, logger }));
  fs.mkdirSync(first.auditDir, { recursive: true });
  writeJson(path.join(first.auditDir, "cloudinary-orphan-cleanup-approved.json"), approved);
  writeJson(path.join(first.auditDir, "cloudinary-orphan-cleanup-blocked.json"), blocked);
  if (mode === "execute") {
    writeJson(path.join(first.auditDir, "cloudinary-orphan-cleanup-executed.json"), executed);
    writeJson(path.join(first.auditDir, "cloudinary-orphan-cleanup-errors.json"), errors);
  }
  const releasedOriginal = bytes(executed, "bytes"), releasedDerived = bytes(executed, "derived_bytes");
  const groups = [...GROUPS].map(group => ({ group, considered: classified.filter(x => x.grupo === group).length, approved: approved.filter(x => x.grupo === group).length, executed: executed.filter(x => x.grupo === group).length, blocked: blocked.filter(x => x.grupo === group).length }));
  const durationMs = Date.now() - runStartedAt;
  const timeoutsBySource = validationResult.diagnostics?.timeoutsBySource || {};
  const validationErrors = classified.filter(item => item.classificacao === CLASSIFICATIONS.ERROR).length;
  const report = ["# Cloudinary orphan cleanup", "", `Modo: ${mode}`, `Limite: ${limit}`, `Duração total: ${(durationMs / 1000).toFixed(1)}s`, `Assets protegidos fora do escopo: ${first.protectedCount}`, "", `- Aprovados: ${approved.length}`, `- Excluídos: ${executed.length}`, `- Bloqueados: ${blocked.length}`, `- Erros: ${errors.length + validationErrors}`, `- Originais liberados: ${mb(releasedOriginal)} MB`, `- Derived liberados: ${mb(releasedDerived)} MB`, `- Total liberado: ${mb(releasedOriginal + releasedDerived)} MB`, "", "## Timeouts por fonte", "", ...Object.entries(timeoutsBySource).map(([source, count]) => `- ${source}: ${count}`), ...(Object.keys(timeoutsBySource).length ? [] : ["- Nenhum"]), "", "## Resultado por grupo", "", ...groups.map(x => `- ${x.group}: considerados ${x.considered}; aprovados ${x.approved}; excluídos ${x.executed}; bloqueados ${x.blocked}`), "", "Nenhum anúncio, token, credencial ou registro de banco foi alterado.", ""].join("\n");
  fs.writeFileSync(path.join(first.auditDir, "cloudinary-orphan-cleanup-report.md"), report);
  logger(`Resumo final: duração=${(durationMs / 1000).toFixed(1)}s; aprovados=${approved.length}; bloqueados=${blocked.length}; erros=${errors.length + validationErrors}; timeouts=${JSON.stringify(timeoutsBySource)}.`);
  return { approved, blocked, executed, errors, totalErrors: errors.length + validationErrors, protectedCount: first.protectedCount, releasedOriginal, releasedDerived, groups, durationMs, timeoutsBySource };
}
