import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const STAGE2_STATUSES = Object.freeze([
  "PENDING", "PREFLIGHT_APPROVED", "PROCESSING", "COMPLETED",
  "SKIPPED_ALREADY_OPTIMIZED", "BLOCKED", "ROLLED_BACK", "FAILED",
]);
export const TERMINAL_STATUSES = new Set(["COMPLETED", "SKIPPED_ALREADY_OPTIMIZED", "ROLLED_BACK", "FAILED"]);

export class CloudinaryRateLimitError extends Error {
  constructor(message = "Cloudinary rate limit") { super(message); this.name = "CloudinaryRateLimitError"; this.httpStatus = 420; }
}
export class SystemicStage2Error extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = "SystemicStage2Error"; }
}

export function parseCloudinaryRateLimitUtc(message) {
  const match = String(message || "").match(/Try\s+again\s+on\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*UTC/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatCloudinaryRateLimit(message, timeZone = "America/Sao_Paulo") {
  const utc = parseCloudinaryRateLimitUtc(message);
  if (!utc) return { found: false, original_message: String(message || "Rate Limit Exceeded") };
  const utcText = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(utc).replace(",", "");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(utc).map(part => [part.type, part.value]));
  return { found: true, utc: utc.toISOString(), utc_text: utcText, sao_paulo_text: `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`, original_message: String(message) };
}

export function ensureExternalBackup({ file, buffer, assetId, publicId, version, format }, fsApi = fs) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("backup externo vazio");
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const expectedSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (!fsApi.existsSync(file)) fsApi.writeFileSync(file, buffer, { flag: "wx" });
  if (!fsApi.existsSync(file)) throw new Error("backup externo não foi criado");
  const saved = fsApi.readFileSync(file);
  if (saved.length === 0) throw new Error("backup externo salvo está vazio");
  const savedSha256 = crypto.createHash("sha256").update(saved).digest("hex");
  if (savedSha256 !== expectedSha256) throw new Error("SHA-256 do backup externo diverge do asset atual");
  return { path: file, bytes: saved.length, sha256: savedSha256, asset_id: assetId, public_id: publicId, version, format, verified: true, valid: true };
}

export function atomicWriteJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fsApi.renameSync(temporary, file);
}

export function newState(candidates = [], now = new Date().toISOString()) {
  return {
    schema_version: 1, created_at: now, updated_at: now,
    legacy_imported: false, candidate_source: null, paused: null,
    assets: candidates.map((candidate, index) => ({
      order: index + 1, public_id: candidate.public_id, asset_id: candidate.asset_id,
      product_id: candidate.product_id || candidate.local_references?.[0]?.product_id || null,
      original_version: candidate.original_version || candidate.version || null,
      current_version: candidate.version || null, bytes_before: candidate.bytes || null,
      bytes_after: null, dimensions_before: dimensions(candidate), dimensions_after: null,
      secure_url: candidate.secure_url || null, format: candidate.format || null,
      created_at: candidate.created_at || null, references: candidate.local_references || [],
      external_backup: null, backup_external_verified: false, backup_external_sha256: null,
      sha256: null, native_backup: null,
      preflight: null, processed_at: null, savings_bytes: 0, error: null,
      status: "PENDING", phase: null,
    })),
  };
}

const dimensions = value => ({ width: Number(value?.width || 0) || null, height: Number(value?.height || 0) || null });
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
const entriesFrom = value => Array.isArray(value) ? value : Array.isArray(value?.assets) ? value.assets : [];

function mergeEvidence(target, source, status) {
  target.product_id ||= source.product_id || source.before?.references?.product_images?.product_id || null;
  target.original_version ||= source.original_version || source.before?.version || source.version || null;
  target.current_version = source.current_version || source.after?.version || target.current_version;
  target.bytes_before ||= source.before?.bytes || source.external_backup?.bytes || source.bytes_before || null;
  target.bytes_after = source.after?.bytes || source.current?.bytes || source.bytes_after || target.bytes_after;
  target.dimensions_before = source.dimensions_before || (source.before ? dimensions(source.before) : target.dimensions_before);
  target.dimensions_after = source.dimensions_after || (source.after ? dimensions(source.after) : target.dimensions_after);
  target.external_backup = source.external_backup || target.external_backup;
  target.sha256 = source.sha256 || source.before?.sha256 || source.external_backup?.sha256 || target.sha256;
  target.native_backup = source.native_backup || source.backup || target.native_backup;
  target.preflight = source.preflight || target.preflight || (status === "PREFLIGHT_APPROVED" ? { status: "APPROVED", imported: true } : null);
  target.processed_at = source.processed_at || source.finished_at || target.processed_at;
  target.savings_bytes = Number(source.savings_bytes ?? source.result?.savings_bytes ?? ((target.bytes_before || 0) - (target.bytes_after || 0)));
  target.status = status;
  target.phase = null;
}

export function importLegacyEvidence(state, { pilot = [], stage2c = [], manifest = [] } = {}) {
  const byPublicId = new Map(state.assets.map(asset => [asset.public_id, asset]));
  for (const source of entriesFrom(pilot)) {
    const target = byPublicId.get(source.public_id); if (!target) continue;
    if (["APPROVED", "COMPLETED"].includes(source.status) || source.after) mergeEvidence(target, source, "COMPLETED");
  }
  const stageEntries = entriesFrom(stage2c);
  for (const [legacyIndex, source] of stageEntries.entries()) {
    const target = byPublicId.get(source.public_id); if (!target) continue;
    target.legacy_priority = legacyIndex + 1;
    if (["OVERWRITTEN_AND_VALID", "APPROVED", "COMPLETED", "SKIPPED_ALREADY_PROCESSED"].includes(source.state || source.status) || source.after) mergeEvidence(target, source, "COMPLETED");
    else if (["PREFLIGHT_APPROVED", "NOT_STARTED"].includes(source.status || source.state) && (source.preflight?.ok || source.preflight_approved)) mergeEvidence(target, source, "PREFLIGHT_APPROVED");
  }
  const approvedIds = new Set([
    ...entriesFrom(stage2c?.preflight).map(x => x.public_id),
    ...(stage2c?.preflight?.assets || []).map(x => x.public_id),
  ]);
  for (const item of manifest.slice(6)) {
    const target = byPublicId.get(item.public_id);
    if (target && (approvedIds.has(item.public_id) || stage2c?.preflight?.ok)) mergeEvidence(target, item, "PREFLIGHT_APPROVED");
  }
  state.legacy_imported = true;
  state.legacy_imported_at = new Date().toISOString();
  return state;
}

export function prioritizeAssets(assets) {
  const rank = status => status === "PREFLIGHT_APPROVED" ? 0 : status === "PROCESSING" ? 1 : status === "PENDING" ? 2 : status === "BLOCKED" ? 3 : 9;
  return [...assets].sort((a, b) => rank(a.status) - rank(b.status) || Number(a.legacy_priority || a.order) - Number(b.legacy_priority || b.order));
}

export function isRecoverableBlocked(asset) { return asset.status === "BLOCKED" && asset.error?.recoverable === true; }
export function nextAsset(state) { return prioritizeAssets(state.assets).find(a => ["PENDING", "PREFLIGHT_APPROVED", "PROCESSING"].includes(a.status) || isRecoverableBlocked(a)) || null; }

export function summarizeState(state) {
  const count = status => state.assets.filter(asset => asset.status === status).length;
  const remaining = state.assets.filter(asset => ["PENDING", "PREFLIGHT_APPROVED", "PROCESSING"].includes(asset.status) || isRecoverableBlocked(asset)).length;
  const bytesBefore = state.assets.reduce((sum, asset) => sum + Number(asset.bytes_before || 0), 0);
  const bytesAfter = state.assets.reduce((sum, asset) => sum + Number(asset.bytes_after ?? asset.bytes_before ?? 0), 0);
  const savings = state.assets.reduce((sum, asset) => sum + Number(asset.savings_bytes || 0), 0);
  return { total: state.assets.length, completed: count("COMPLETED"), skipped: count("SKIPPED_ALREADY_OPTIMIZED"), pending: count("PENDING"), remaining,
    preflight_approved: count("PREFLIGHT_APPROVED"), blocked: count("BLOCKED"), failed: count("FAILED"), rolled_back: count("ROLLED_BACK"),
    bytes_original: bytesBefore, bytes_current: bytesAfter, savings_bytes: savings,
    savings_percent: bytesBefore ? Number((savings * 100 / bytesBefore).toFixed(2)) : 0, next_asset: nextAsset(state)?.public_id || null };
}

export function writeReports(state, directory) {
  const summary = summarizeState(state), report = { generated_at: new Date().toISOString(), ...summary,
    manual_review: state.assets.filter(a => ["BLOCKED", "FAILED", "ROLLED_BACK"].includes(a.status)).map(a => ({ public_id: a.public_id, status: a.status, reason: a.error?.message || null })) };
  atomicWriteJson(path.join(directory, "report.json"), report);
  const mb = n => (Number(n || 0) / 1048576).toFixed(2);
  fs.writeFileSync(path.join(directory, "report.md"), `# Cloudinary Stage 2 global\n\nCandidatos: ${report.total}. Completed: ${report.completed}. Skipped: ${report.skipped}. Blocked: ${report.blocked}. Failed: ${report.failed}. Rollback: ${report.rolled_back}. Pendentes: ${report.pending}.\n\nOriginais: ${mb(report.bytes_original)} MB. Atuais: ${mb(report.bytes_current)} MB. Economia: ${mb(report.savings_bytes)} MB (${report.savings_percent}%).\n\n## Revisão manual\n\n${report.manual_review.length ? report.manual_review.map(x => `- \`${x.public_id}\` — ${x.status}: ${x.reason}`).join("\n") : "Nenhum asset."}\n`);
  return report;
}

export async function runGlobalExecutor({ state, checkpoint, preflight, processAsset, recover, logger = console.log, signal = { requested: false } }) {
  for (;;) {
    if (signal.requested) break;
    const asset = nextAsset(state); if (!asset) break;
    const label = `[${asset.order}/${state.assets.length}]`;
    try {
      if (asset.status === "PROCESSING") await recover(asset);
      if (isRecoverableBlocked(asset)) asset.status = asset.preflight?.status === "APPROVED" ? "PREFLIGHT_APPROVED" : "PENDING";
      if (asset.status === "PENDING") {
        logger(`${label} START ${asset.public_id}`);
        const result = await preflight(asset);
        if (result?.alreadyOptimized) { asset.status = "SKIPPED_ALREADY_OPTIMIZED"; asset.processed_at = new Date().toISOString(); await checkpoint(); continue; }
        if (!result?.approved) { asset.status = "BLOCKED"; asset.error = { message: result?.reason || "preflight não aprovado", recoverable: false }; await checkpoint(); continue; }
        asset.preflight = { ...result, status: "APPROVED", checked_at: new Date().toISOString() }; asset.status = "PREFLIGHT_APPROVED"; await checkpoint(); logger(`${label} PREFLIGHT OK`);
      }
      if (signal.requested) break;
      if (asset.status === "PREFLIGHT_APPROVED") {
        asset.status = "PROCESSING"; asset.phase = "BEFORE_OVERWRITE"; await checkpoint();
        const result = await processAsset(asset, async phase => { asset.phase = phase; await checkpoint(); });
        Object.assign(asset, result, { status: "COMPLETED", phase: null, processed_at: new Date().toISOString(), error: null }); await checkpoint();
      }
    } catch (error) {
      if (Number(error?.httpStatus || error?.http_status) === 420) { state.paused = { reason: "CLOUDINARY_RATE_LIMIT", at: new Date().toISOString(), retry_after: error.retryAfter || null }; await checkpoint(); throw new CloudinaryRateLimitError(error.message); }
      if (error instanceof SystemicStage2Error || error?.systemic) { await checkpoint(); throw error; }
      asset.status = error?.rolledBack ? "ROLLED_BACK" : "BLOCKED"; asset.phase = null; asset.error = { message: String(error?.message || error), recoverable: Boolean(error?.recoverable) }; await checkpoint();
    }
  }
  return state;
}

export function loadLegacyFiles(root) {
  const find = names => names.map(name => path.join(root, name)).find(file => fs.existsSync(file));
  const pilotFile = find(["artifacts/cloudinary-stage2-pilot/report.json"]);
  const stage2cFile = find(["artifacts/cloudinary-stage2-batch/resume-checkpoint.json", "artifacts/cloudinary-stage2-batch/report.json", "artifacts/cloudinary-stage2-batch/interrupted-inspection.json"]);
  const manifestFile = find(["scripts/data/cloudinary-stage2c-batch-20.json"]);
  const evidenceFile = find(["scripts/data/cloudinary-stage2-legacy-evidence.json"]);
  const evidence = evidenceFile ? readJson(evidenceFile) : null;
  return { pilot: evidence?.pilot || (pilotFile ? readJson(pilotFile) : []), stage2c: evidence?.stage2c || (stage2cFile ? readJson(stage2cFile) : []), manifest: manifestFile ? readJson(manifestFile) : [] };
}
