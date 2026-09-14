import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { CUTOFF_ISO, POLICY, isLegacyCandidate, sha256 } from "../lib/cloudinary-legacy-optimize.mjs";
import { evaluateDatabaseReferences } from "../lib/cloudinary-stage2-inspection.mjs";
import {
  CloudinaryRateLimitError, SystemicStage2Error, atomicWriteJson, ensureExternalBackup, formatCloudinaryRateLimit, importLegacyEvidence,
  loadLegacyFiles, newState, runGlobalExecutor, summarizeState, writeReports,
} from "../lib/cloudinary-stage2-global.mjs";

const ROOT = process.cwd(), OUT = path.join(ROOT, "artifacts", "cloudinary-stage2-global");
const STATE_FILE = path.join(OUT, "state.json"), BACKUPS = path.join(OUT, "backups"), TIMEOUT = 30000;
const args = process.argv.slice(2);
if (args.length !== 1 || !["--continue", "--status", "--usage"].includes(args[0])) throw new Error("Use --continue, --status ou --usage.");

function env(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/); if (!m || process.env[m[1]]) continue; let value = m[2]; if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1); process.env[m[1]] = value.replace(/\\n/g, "\n"); } }
const basic = account => `Basic ${Buffer.from(`${account.key}:${account.secret}`).toString("base64")}`;
const safe = value => String(value || "falha externa").replace(/(Basic|Bearer)\s+\S+/gi, "$1 [REDACTED]").slice(0, 500);
async function request(url, options = {}, binary = false, cloudinary = false) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (error) { const wrapped = new SystemicStage2Error(`indisponibilidade geral: ${safe(error.message)}`, error); wrapped.systemic = true; throw wrapped; }
  const retryAfter = response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset");
  if (cloudinary && response.status === 420) { const body = await response.text().catch(() => ""); let detail = body; try { const parsed = JSON.parse(body); detail = parsed?.error?.message || parsed?.message || body; } catch {} const error = new CloudinaryRateLimitError(detail || "Rate Limit Exceeded"); error.retryAfter = retryAfter; throw error; }
  if (binary) { const body = Buffer.from(await response.arrayBuffer()); if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status, systemic: response.status === 401 || response.status >= 500 }); return body; }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) throw Object.assign(new Error(safe(body?.error?.message || body?.message || `HTTP ${response.status}`)), { httpStatus: response.status, systemic: response.status === 401 || response.status >= 500 });
  return body;
}
async function rows(db, table, columns) { const out = []; for (let from = 0; ; from += 1000) { const result = await db.from(table).select(columns).range(from, from + 999); if (result.error) throw new SystemicStage2Error(`${table}: ${result.error.message}`); out.push(...(result.data || [])); if (!result.data || result.data.length < 1000) return out; } }
const detail = (account, assetId) => request(`https://api.cloudinary.com/v1_1/${account.cloud}/resources/${encodeURIComponent(assetId)}?versions=true&max_results=100`, { headers: { Authorization: basic(account) } }, false, true);
async function upload(account, buffer, asset) { const form = new FormData(); form.set("file", new Blob([buffer], { type: asset.format === "png" ? "image/png" : "image/jpeg" }), `asset.${asset.format}`); form.set("public_id", asset.public_id); form.set("overwrite", "true"); form.set("invalidate", "true"); return request(`https://api.cloudinary.com/v1_1/${account.cloud}/image/upload`, { method: "POST", headers: { Authorization: basic(account) }, body: form }, false, true); }
async function optimize(buffer, format) { let pipeline = sharp(buffer, { failOn: "warning" }).rotate().resize({ width: POLICY.maxDimension, height: POLICY.maxDimension, fit: "inside", withoutEnlargement: true }); pipeline = /png/i.test(format) ? pipeline.png({ compressionLevel: POLICY.pngCompressionLevel, adaptiveFiltering: true }) : pipeline.jpeg({ quality: POLICY.jpegQuality, progressive: true, chromaSubsampling: POLICY.jpegChromaSubsampling, mozjpeg: true }); return pipeline.toBuffer(); }
function human(bytes) { return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(2)} MB`; }
function show(state) { const s = summarizeState(state); console.log(`Total conhecido: ${s.total}\nCompleted: ${s.completed}\nPreflight aprovado: ${s.preflight_approved}\nPendentes: ${s.pending}\nRestantes executáveis: ${s.remaining}\nBloqueados: ${s.blocked}\nEconomia: ${human(s.savings_bytes)}\nPróximo asset: ${s.next_asset || "nenhum"}`); }
function loadState() { const existed = fs.existsSync(STATE_FILE); const candidates = JSON.parse(fs.readFileSync(new URL("./data/cloudinary-stage2-global-candidates.json", import.meta.url), "utf8")); const state = existed ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : newState(candidates); state.candidate_source ||= { type: "persisted-rule-snapshot", rule: "isLegacyCandidate", cutoff: CUTOFF_ISO, count: candidates.length }; const legacy = loadLegacyFiles(ROOT); if (!state.legacy_imported) importLegacyEvidence(state, legacy); const byId = new Map(state.assets.map(asset => [asset.public_id, asset])); for (const [index, item] of legacy.manifest.entries()) { const asset = byId.get(item.public_id); if (asset) asset.legacy_priority = index + 1; } atomicWriteJson(STATE_FILE, state); writeReports(state, OUT); return state; }

const state = loadState();
if (args[0] === "--status") { show(state); process.exit(0); }
env(path.join(ROOT, ".env.local")); env(path.join(ROOT, ".env.vercel.local"));
async function configuration() {
  const dbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !dbKey) throw new SystemicStage2Error("credencial Supabase ausente");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, dbKey, { auth: { persistSession: false } });
  const settings = await db.from("settings").select("key,value").in("key", ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]);
  if (settings.error) throw new SystemicStage2Error(`settings: ${settings.error.message}`);
  const map = new Map((settings.data || []).map(item => [item.key, String(item.value || "")]));
  const account = { cloud: map.get("CLOUDINARY_CLOUD_NAME") || process.env.CLOUDINARY_CLOUD_NAME, key: map.get("CLOUDINARY_API_KEY") || process.env.CLOUDINARY_API_KEY, secret: map.get("CLOUDINARY_API_SECRET") || process.env.CLOUDINARY_API_SECRET };
  if (!account.cloud || !account.key || !account.secret) throw new SystemicStage2Error("credencial Cloudinary ausente");
  return { db, account };
}
const { db, account } = await configuration();
if (args[0] === "--usage") { const usage = await request(`https://api.cloudinary.com/v1_1/${account.cloud}/usage`, { headers: { Authorization: basic(account) } }, false, true); console.log(JSON.stringify(usage, null, 2)); process.exit(0); }

const cache = {};
async function databaseSnapshot() {
  if (cache.images) return cache;
  [cache.images, cache.products, cache.links, cache.listings, cache.pending] = await Promise.all([
    rows(db, "product_images", "id,product_id,position,status,url,cloudinary_url,cloudinary_public_id,cloudinary_cloud_name,cloudinary_asset_id,bytes,width_px,height_px"), rows(db, "products", "id,sku,status,tiny_product_id"),
    rows(db, "product_marketplaces", "id,product_id,sku,marketplace,marketplace_account_id,marketplace_product_id,status_anuncio,raw_data"), rows(db, "listings", "id,product_id,marketplace,external_listing_id,external_sku,status"),
    db.from("outgoing_marketplace_activities").select("id,product_id,sku,status").in("status", ["pending", "queued", "processing", "retry", "running"]).limit(1000).then(result => { if (result.error) throw new SystemicStage2Error(result.error.message); return result.data || []; }),
  ]);
  return cache;
}
async function preflight(asset) {
  const snapshot = await databaseSnapshot(), current = await detail(account, asset.asset_id);
  if (Math.max(Number(current.width), Number(current.height)) <= POLICY.maxDimension) return { alreadyOptimized: true };
  const verdict = isLegacyCandidate(current, snapshot.images, CUTOFF_ISO);
  if (!verdict.eligible) return { approved: false, reason: verdict.reason };
  const assessment = evaluateDatabaseReferences({ expected: current, imageRows: snapshot.images, products: snapshot.products, marketplaceLinks: snapshot.links, listings: snapshot.listings });
  if (assessment.state !== "CONSISTENT") return { approved: false, reason: assessment.reason };
  const productId = assessment.references[0]?.product_id;
  const product = snapshot.products.find(item => String(item.id) === String(productId));
  if (snapshot.pending.some(item => String(item.product_id) === String(productId) || String(item.sku).toUpperCase() === String(product?.sku).toUpperCase())) return { approved: false, reason: "operação de marketplace pendente" };
  const urls = [...new Set(verdict.references.flatMap(row => [row.url, row.cloudinary_url]).filter(Boolean))];
  for (const url of urls) await request(`${url}${url.includes("?") ? "&" : "?"}_stage2=${Date.now()}`, { cache: "no-store" }, true);
  return { approved: true, identity: { asset_id: current.asset_id, public_id: current.public_id, version: current.version }, database: assessment, persisted_urls: urls, marketplaces: "aprovado pela política conservadora e evidência local; sem escrita" };
}
async function processAsset(asset, phase) {
  const current = await detail(account, asset.asset_id);
  if (String(current.asset_id) !== String(asset.asset_id) || String(current.public_id) !== String(asset.public_id)) throw new Error("identidade atual divergiu");
  const original = await request(current.secure_url, { cache: "no-store" }, true), originalHash = sha256(original), meta = await sharp(original).metadata();
  const backupPath = path.join(BACKUPS, `${asset.asset_id}__v${current.version}.${current.format}`);
  asset.external_backup = ensureExternalBackup({ file: backupPath, buffer: original, assetId: current.asset_id, publicId: current.public_id, version: current.version, format: current.format }); asset.backup_external_verified = true; asset.backup_external_sha256 = asset.external_backup.sha256; asset.sha256 = originalHash; asset.bytes_before = original.length; asset.dimensions_before = { width: meta.width, height: meta.height }; await phase("EXTERNAL_BACKUP_READY"); console.log(`[${asset.order}/${state.assets.length}] BACKUP EXTERNO OK`); console.log(`[${asset.order}/${state.assets.length}] SHA-256 OK`);
  const optimized = await optimize(original, current.format), optimizedHash = sha256(optimized); asset.optimized_sha256 = optimizedHash; console.log(`[${asset.order}/${state.assets.length}] OTIMIZANDO`);
  let changed;
  try {
    changed = await upload(account, optimized, current); await phase("OVERWRITE_DONE"); console.log(`[${asset.order}/${state.assets.length}] OVERWRITE OK`); console.log(`[${asset.order}/${state.assets.length}] VALIDANDO`);
    const after = await detail(account, asset.asset_id), delivered = await request(`${changed.secure_url}?_validate=${Date.now()}`, { cache: "no-store" }, true), afterMeta = await sharp(delivered).metadata();
    if (changed.asset_id !== asset.asset_id || changed.public_id !== asset.public_id || sha256(delivered) !== optimizedHash || Number(after.bytes) >= original.length || Math.max(afterMeta.width, afterMeta.height) > POLICY.maxDimension) throw new Error("validação pós-overwrite falhou");
    const result = { current_version: after.version, bytes_after: Number(after.bytes), dimensions_after: { width: afterMeta.width, height: afterMeta.height }, savings_bytes: original.length - Number(after.bytes) };
    console.log(`[${asset.order}/${state.assets.length}] COMPLETED — ${human(original.length)} -> ${human(after.bytes)} — -${((1 - after.bytes / original.length) * 100).toFixed(1)}%`); return result;
  } catch (error) {
    if (Number(error?.httpStatus) === 420) throw error;
    const restoredUpload = await upload(account, fs.readFileSync(asset.external_backup.path), current); const restored = await detail(account, asset.asset_id); const bytes = await request(`${restoredUpload.secure_url}?_rollback=${Date.now()}`, { cache: "no-store" }, true);
    const rollbackOk = restored.asset_id === asset.asset_id && restored.public_id === asset.public_id && sha256(bytes) === originalHash; const wrapped = new Error(`${error.message}; rollback externo ${rollbackOk ? "confirmado" : "não confirmado"}`); wrapped.rolledBack = rollbackOk; throw wrapped;
  }
}
async function recoverAsset(asset) {
  if (["BEFORE_OVERWRITE", "EXTERNAL_BACKUP_READY", "NATIVE_BACKUP_READY"].includes(asset.phase)) { asset.status = "PREFLIGHT_APPROVED"; asset.phase = null; await checkpoint(); return; }
  if (asset.phase !== "OVERWRITE_DONE" || !asset.optimized_sha256 || !asset.external_backup?.path || !asset.sha256) throw Object.assign(new Error("estado PROCESSING sem backup externo verificado para recuperação"), { recoverable: false });
  const current = await detail(account, asset.asset_id), delivered = await request(`${current.secure_url}?_recover=${Date.now()}`, { cache: "no-store" }, true), hash = sha256(delivered);
  if (hash === asset.optimized_sha256 && current.asset_id === asset.asset_id && current.public_id === asset.public_id && Number(current.bytes) < Number(asset.bytes_before)) {
    const meta = await sharp(delivered).metadata(); Object.assign(asset, { status: "COMPLETED", phase: null, current_version: current.version, bytes_after: Number(current.bytes), dimensions_after: { width: meta.width, height: meta.height }, savings_bytes: Number(asset.bytes_before) - Number(current.bytes), processed_at: new Date().toISOString(), error: null }); await checkpoint(); return;
  }
  const backup = fs.readFileSync(asset.external_backup.path); if (backup.length === 0 || sha256(backup) !== asset.sha256) throw Object.assign(new Error("backup externo inválido durante recuperação"), { recoverable: false });
  const restoredUpload = await upload(account, backup, asset), restored = await detail(account, asset.asset_id), original = await request(`${restoredUpload.secure_url}?_recover_rollback=${Date.now()}`, { cache: "no-store" }, true);
  asset.status = restored.asset_id === asset.asset_id && restored.public_id === asset.public_id && sha256(original) === asset.sha256 ? "ROLLED_BACK" : "BLOCKED"; asset.phase = null; asset.error = { message: asset.status === "ROLLED_BACK" ? "interrupção pós-overwrite: rollback externo confirmado" : "interrupção pós-overwrite: rollback externo não comprovado", recoverable: false }; await checkpoint();
}
const stop = { requested: false };
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => { stop.requested = true; console.warn(`${event} recebido; nenhum próximo asset será iniciado.`); });
async function checkpoint() { state.updated_at = new Date().toISOString(); atomicWriteJson(STATE_FILE, state); writeReports(state, OUT); }
try {
  state.paused = null; await checkpoint(); await runGlobalExecutor({ state, checkpoint, preflight, processAsset, recover: recoverAsset, signal: stop });
  await checkpoint(); show(state);
} catch (error) {
  await checkpoint();
  if (error instanceof CloudinaryRateLimitError) { const s = summarizeState(state), release = formatCloudinaryRateLimit(error.message); const releaseText = release.found ? `Cloudinary informou liberação: ${release.utc_text} UTC\nHorário de São Paulo: ${release.sao_paulo_text}\nPara continuar depois desse horário:\nnode scripts/cloudinary-stage2-global.mjs --continue` : `Erro original: ${error.message}\nPara continuar quando o limite for liberado:\nnode scripts/cloudinary-stage2-global.mjs --continue`; console.error(`PAUSADO — CLOUDINARY RATE LIMIT\n${releaseText}\nConcluídos: ${s.completed}\nPendentes: ${s.remaining}\nBloqueados: ${s.blocked}\nEconomia acumulada: ${human(s.savings_bytes)}\nPróximo asset: ${s.next_asset || "nenhum"}`); process.exitCode = 2; }
  else { console.error(`PAUSADO — FALHA SISTÊMICA: ${safe(error.message)}`); process.exitCode = 1; }
}
