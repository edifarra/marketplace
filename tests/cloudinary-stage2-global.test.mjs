import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CloudinaryRateLimitError, SystemicStage2Error, atomicWriteJson, ensureExternalBackup, formatCloudinaryRateLimit, importLegacyEvidence,
  newState, nextAsset, runGlobalExecutor, summarizeState,
} from "../lib/cloudinary-stage2-global.mjs";

const candidates = count => Array.from({ length: count }, (_, index) => ({ asset_id: `a${index}`, public_id: `produtos/${index}`, version: 1, bytes: 2000, width: 2000, height: 1500, product_id: `p${index}` }));
const checkpointFor = state => async () => { state.checkpoints = (state.checkpoints || 0) + 1; };

test("imports 3 Stage2B, 6 Stage2C completed and 14 preflight-approved", () => {
  const state = newState(candidates(23));
  importLegacyEvidence(state, {
    pilot: state.assets.slice(0, 3).map(a => ({ public_id: a.public_id, status: "COMPLETED" })),
    stage2c: { preflight: { ok: true, assets: state.assets.slice(9).map(a => ({ public_id: a.public_id })) }, assets: state.assets.slice(3).map((a, i) => ({ public_id: a.public_id, status: i < 6 ? "COMPLETED" : "PREFLIGHT_APPROVED", preflight_approved: i >= 6 })) },
  });
  assert.equal(summarizeState(state).completed, 9);
  assert.equal(summarizeState(state).preflight_approved, 14);
});

test("completed is never processed and approved asset has priority", async () => {
  const state = newState(candidates(3)); state.assets[0].status = "COMPLETED"; state.assets[2].status = "PREFLIGHT_APPROVED";
  const visited = [];
  await runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async a => ({ approved: true }), processAsset: async a => { visited.push(a.public_id); return { bytes_after: 1000, savings_bytes: 1000 }; }, recover: async () => {} });
  assert.deepEqual(visited, ["produtos/2", "produtos/1"]);
});

test("HTTP 420 pauses without failing asset and resumes on next run", async () => {
  const state = newState(candidates(2)); let limited = true;
  await assert.rejects(runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async () => ({ approved: true }), processAsset: async a => { if (limited) { limited = false; throw Object.assign(new Error("rate"), { httpStatus: 420 }); } return { bytes_after: 1000 }; }, recover: async a => { a.status = "PREFLIGHT_APPROVED"; a.phase = null; } }), CloudinaryRateLimitError);
  assert.equal(state.assets[0].status, "PROCESSING");
  await runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async () => ({ approved: true }), processAsset: async () => ({ bytes_after: 1000 }), recover: async a => { a.status = "PREFLIGHT_APPROVED"; a.phase = null; } });
  assert.equal(summarizeState(state).completed, 2);
});

test("SIGINT before next asset preserves approved state", async () => {
  const state = newState(candidates(2)), signal = { requested: false };
  await runGlobalExecutor({ state, checkpoint: checkpointFor(state), signal, preflight: async () => ({ approved: true }), processAsset: async () => { signal.requested = true; return { bytes_after: 1000 }; }, recover: async () => {} });
  assert.equal(state.assets[0].status, "COMPLETED"); assert.equal(state.assets[1].status, "PENDING");
});

test("individual blocked asset does not stop batch", async () => {
  const state = newState(candidates(3));
  await runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async a => a.asset_id === "a1" ? { approved: false, reason: "ambíguo" } : { approved: true }, processAsset: async () => ({ bytes_after: 1000 }), recover: async () => {} });
  assert.equal(summarizeState(state).completed, 2); assert.equal(summarizeState(state).blocked, 1);
});

test("systemic error stops batch", async () => {
  const state = newState(candidates(2));
  await assert.rejects(runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async () => { throw new SystemicStage2Error("credential"); }, processAsset: async () => ({}), recover: async () => {} }), SystemicStage2Error);
  assert.equal(state.assets[1].status, "PENDING");
});

test("atomic checkpoint leaves valid JSON and no temporary file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-global-")), file = path.join(directory, "state.json");
  atomicWriteJson(file, { ok: true }); assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ok: true }); assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("backup policy does not duplicate an existing valid file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-backup-")), file = path.join(directory, "asset.jpg"); fs.writeFileSync(file, "original", { flag: "wx" });
  assert.throws(() => fs.writeFileSync(file, "duplicate", { flag: "wx" }), /exist/i); assert.equal(fs.readFileSync(file, "utf8"), "original");
});

test("rollback result is persisted and processing continues", async () => {
  const state = newState(candidates(2));
  await runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async () => ({ approved: true }), processAsset: async a => { if (a.asset_id === "a0") throw Object.assign(new Error("invalid"), { rolledBack: true }); return { bytes_after: 1000 }; }, recover: async () => {} });
  assert.equal(state.assets[0].status, "ROLLED_BACK"); assert.equal(state.assets[1].status, "COMPLETED");
});

test("status summary and next candidate use local state only", () => {
  const state = newState(candidates(3)); state.assets[0].status = "COMPLETED"; state.assets[1].status = "PREFLIGHT_APPROVED";
  assert.equal(nextAsset(state).public_id, "produtos/1"); assert.equal(summarizeState(state).pending, 1); assert.equal(summarizeState(state).remaining, 2);
});

test("hundreds of candidates are processed without a fixed batch", async () => {
  const state = newState(candidates(500));
  await runGlobalExecutor({ state, checkpoint: checkpointFor(state), preflight: async () => ({ approved: true }), processAsset: async () => ({ bytes_after: 1000, savings_bytes: 1000 }), recover: async () => {}, logger: () => {} });
  assert.equal(summarizeState(state).completed, 500); assert.equal(state.checkpoints, 1500);
});

test("converts Cloudinary UTC release to America/Sao_Paulo", () => {
  const result = formatCloudinaryRateLimit("Rate Limit Exceeded. Try again on 2026-09-14 10:30:00 UTC");
  assert.equal(result.utc_text, "2026-09-14 10:30"); assert.equal(result.sao_paulo_text, "14/09/2026 às 07:30");
});

test("UTC conversion preserves the previous local calendar day", () => {
  const result = formatCloudinaryRateLimit("Try again on 2026-09-14 01:00:00 UTC");
  assert.equal(result.sao_paulo_text, "13/09/2026 às 22:00");
});

test("420 message with release time returns display-ready details", () => {
  const result = formatCloudinaryRateLimit("Rate Limit Exceeded: Try again on 2026-09-14 01:00:00 UTC");
  assert.equal(result.found, true); assert.equal(result.utc, "2026-09-14T01:00:00.000Z");
});

test("420 message without release time preserves original error", () => {
  const message = "Rate Limit Exceeded without reset information", result = formatCloudinaryRateLimit(message);
  assert.equal(result.found, false); assert.equal(result.original_message, message);
});

test("formatting reset time performs no Cloudinary call", () => {
  let calls = 0; const previous = globalThis.fetch; globalThis.fetch = async () => { calls += 1; throw new Error("unexpected request"); };
  try { formatCloudinaryRateLimit("Try again on 2026-09-14 01:00:00 UTC"); assert.equal(calls, 0); } finally { globalThis.fetch = previous; }
});

test("new external backup is mandatory, non-empty and SHA-256 verified", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-external-")), file = path.join(directory, "asset__v7.jpg"), buffer = Buffer.from("original asset");
  const result = ensureExternalBackup({ file, buffer, assetId: "asset-1", publicId: "produtos/1", version: 7, format: "jpg" });
  assert.equal(result.verified, true); assert.equal(result.bytes, buffer.length); assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.equal(result.version, 7);
});

test("empty or divergent external backup prevents overwrite preparation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-external-fail-")), file = path.join(directory, "asset__v1.jpg");
  assert.throws(() => ensureExternalBackup({ file, buffer: Buffer.alloc(0), assetId: "a", publicId: "p", version: 1, format: "jpg" }), /vazio/);
  fs.writeFileSync(file, "different");
  assert.throws(() => ensureExternalBackup({ file, buffer: Buffer.from("expected"), assetId: "a", publicId: "p", version: 1, format: "jpg" }), /SHA-256/);
});

test("executor has no native backup calls and rollback uploads external backup", () => {
  const source = fs.readFileSync(new URL("../scripts/cloudinary-stage2-global.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /download_backup|resources\/restore|form\.set\(["']backup["']/);
  assert.doesNotMatch(source, /BACKUP NATIVO OK/);
  assert.match(source, /upload\(account, fs\.readFileSync\(asset\.external_backup\.path\)/);
  assert.match(source, /sha256\(backup\) !== asset\.sha256/);
});

test("legacy state with native backup remains compatible", () => {
  const state = newState(candidates(1)); state.assets[0].native_backup = { version_id: "legacy-version", recoverable: true }; state.assets[0].status = "COMPLETED";
  assert.equal(summarizeState(state).completed, 1); assert.equal(nextAsset(state), null); assert.equal(state.assets[0].native_backup.version_id, "legacy-version");
});
