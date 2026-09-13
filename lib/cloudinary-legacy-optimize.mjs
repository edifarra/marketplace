import crypto from "node:crypto";

export const CUTOFF_ISO = "2026-09-08T02:52:21.000Z";
export const MAX_LIMIT = 3;
export const POLICY = Object.freeze({ maxDimension: 1200, jpegQuality: 88, jpegChromaSubsampling: "4:4:4", pngCompressionLevel: 9 });
const SECRET_KEYS = /(?:token|secret|authorization|partner[_-]?key|service[_-]?role|api[_-]?key|signature|password)/i;

export function parseOptimizeArgs(argv) {
  const execute = argv.includes("--execute");
  if (execute && argv.includes("--dry-run")) throw new Error("Use somente um modo: --dry-run ou --execute.");
  const raw = argv.find(value => value.startsWith("--limit="))?.slice(8);
  const limit = raw === undefined ? 3 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("--limit deve ser um inteiro entre 1 e 3.");
  const unknown = argv.filter(value => !["--dry-run", "--execute"].includes(value) && !value.startsWith("--limit="));
  if (unknown.length) throw new Error(`Argumentos desconhecidos: ${unknown.join(", ")}`);
  return { mode: execute ? "execute" : "dry-run", limit };
}

export function normalizePublicId(value) {
  const text = String(value || "");
  const scoped = text.includes("::") ? text.slice(text.indexOf("::") + 2) : text;
  return scoped.replace(/\.(jpe?g|png|webp|avif|gif)$/i, "");
}
export const cloudNameFromUrl = value => String(value || "").match(/res\.cloudinary\.com\/([^/]+)/i)?.[1] || "";
export function publicIdFromUrl(value) {
  if (!/res\.cloudinary\.com/i.test(String(value || ""))) return "";
  try {
    const parts = decodeURIComponent(new URL(String(value)).pathname).split("/").filter(Boolean);
    const upload = parts.indexOf("upload"); if (upload < 0) return "";
    let rest = parts.slice(upload + 1); const version = rest.findIndex(part => /^v\d+$/.test(part));
    if (version >= 0) rest = rest.slice(version + 1); else if (rest.includes("produtos")) rest = rest.slice(rest.indexOf("produtos"));
    return normalizePublicId(rest.join("/"));
  } catch { return ""; }
}

export function isLegacyCandidate(asset, rows, cutoff = CUTOFF_ISO) {
  if (!asset?.asset_id || !asset?.public_id || !asset?.secure_url) return { eligible: false, reason: "metadados incompletos" };
  if (new Date(asset.created_at || 0) >= new Date(cutoff)) return { eligible: false, reason: "NOVA_POLITICA" };
  if (Math.max(Number(asset.width || 0), Number(asset.height || 0)) <= POLICY.maxDimension) return { eligible: false, reason: "já otimizado" };
  const publicId = normalizePublicId(asset.public_id);
  const matches = rows.filter(row => String(row.cloudinary_asset_id || "") === String(asset.asset_id) || normalizePublicId(row.cloudinary_public_id) === publicId || publicIdFromUrl(row.cloudinary_url) === publicId || publicIdFromUrl(row.url) === publicId);
  if (!matches.length) return { eligible: false, reason: "INCERTO: sem referência atual inequívoca" };
  const clouds = new Set(matches.map(row => row.cloudinary_cloud_name || cloudNameFromUrl(row.cloudinary_url || row.url)).filter(Boolean));
  if (clouds.size > 1 || (clouds.size === 1 && !clouds.has(cloudNameFromUrl(asset.secure_url)))) return { eligible: false, reason: "INCERTO: conta divergente" };
  return { eligible: true, reason: "LEGADO referenciado", references: matches };
}

export function selectPilotCandidates(candidates, limit = 3) {
  if (limit > MAX_LIMIT) throw new Error("Limite rígido excedido (3).");
  const sorted = [...candidates].sort((a, b) => Number(a.bytes || 0) - Number(b.bytes || 0));
  if (sorted.length <= limit) return sorted;
  const indexes = limit === 1 ? [Math.floor((sorted.length - 1) / 2)] : limit === 2 ? [0, sorted.length - 1] : [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1];
  return indexes.map(index => sorted[index]);
}
export function outputDimensions(width, height, max = POLICY.maxDimension) { const scale = Math.min(1, max / Math.max(Number(width), Number(height))); return { width: Math.max(1, Math.round(Number(width) * scale)), height: Math.max(1, Math.round(Number(height) * scale)) }; }
export function estimateBytes(asset) { const d = outputDimensions(asset.width, asset.height); const ratio = (d.width * d.height) / Math.max(1, Number(asset.width) * Number(asset.height)); return Math.max(1, Math.round(Number(asset.bytes || 0) * ratio * (String(asset.format).toLowerCase() === "png" ? .82 : .9))); }
export function summarizeSavings(candidates, samples = []) {
  const current = candidates.reduce((s, x) => s + Number(x.bytes || 0), 0); const ratios = samples.filter(x => x.before_bytes > 0).map(x => x.after_bytes / x.before_bytes);
  const estimated = ratios.length ? Math.round(current * ratios.reduce((a,b) => a+b, 0) / ratios.length) : candidates.reduce((s,x) => s + estimateBytes(x), 0);
  const derivedBytes = candidates.reduce((s,x) => s + Number(x.derived_bytes || 0), 0); const derivedCount = candidates.reduce((s,x) => s + Number(x.derived_count || 0), 0);
  return { count: candidates.length, originals_current_bytes: current, originals_estimated_bytes: estimated, originals_savings_bytes: current-estimated, reduction_percent: current ? Number(((current-estimated)*100/current).toFixed(2)) : 0, derived_count: derivedCount, derived_bytes: derivedBytes, total_current_bytes: current+derivedBytes, total_estimated_bytes: estimated+derivedBytes };
}
export function redactSecrets(value) { if (Array.isArray(value)) return value.map(redactSecrets); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, SECRET_KEYS.test(k) ? "[REDACTED]" : redactSecrets(v)])); if (typeof value === "string") return value.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]"); return value; }
export const sha256 = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
export async function processIndividually(items, handler) { const results=[]; for (const item of items) { try { results.push({ok:true,asset_id:item.asset_id,value:await handler(item)}); } catch(error) { results.push({ok:false,asset_id:item.asset_id,error:String(error?.message||error)}); } } return results; }
export function assertOverwriteIdentity(before, after) { if (normalizePublicId(before.public_id) !== normalizePublicId(after.public_id)) throw new Error("public_id mudou após overwrite"); if (before.asset_id && after.asset_id && before.asset_id !== after.asset_id) throw new Error("asset_id mudou após overwrite"); return true; }
export function rollbackReady({originalBuffer, originalSha256, publicId, fetchedPublicId}) { return Buffer.isBuffer(originalBuffer) && originalBuffer.length > 0 && sha256(originalBuffer) === originalSha256 && normalizePublicId(publicId) === normalizePublicId(fetchedPublicId); }
