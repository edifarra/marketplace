import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLASSIFICATIONS, classifyCandidate, executeApproved, parseCleanupArgs, redactSecrets, runCleanup } from "../lib/cloudinary-orphan-cleanup.mjs";

const asset = { asset_id: "a1", public_id: "produtos/SKU/master", sku: "SKU", grupo: "SEM_ASSOCIACAO_LOCAL", bytes: 100, derived_bytes: 20 };
const validation = classification => async root => ({ auditDir: root, protectedCount: 282, stage: [asset], classified: [{ ...asset, classificacao: classification }] });

test("dry run nunca chama destroy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudinary-cleanup-"));
  let calls = 0;
  const result = await runCleanup({ root, mode: "dry-run", validateFn: validation(CLASSIFICATIONS.SAFE), destroyFn: async () => { calls++; }, logger() {} });
  assert.equal(calls, 0); assert.equal(result.executed.length, 0);
});

test("token expirado bloqueia e nunca dispara refresh", async () => {
  let refreshCalls = 0;
  const result = classifyCandidate(asset, { complete: false, currentReferences: [], errors: [], unavailable: [], expired: ["token expirado"], notes: [], refresh: () => refreshCalls++ });
  assert.equal(result.classificacao, CLASSIFICATIONS.EXPIRED); assert.equal(refreshCalls, 0);
});

test("referência atual nunca entra no lote seguro", () => {
  assert.equal(classifyCandidate(asset, { complete: true, currentReferences: [{}], errors: [], unavailable: [], expired: [], notes: [] }).classificacao, CLASSIFICATIONS.REFERENCE);
});

test("fonte inacessível não é tratada como ausência", () => {
  assert.equal(classifyCandidate(asset, { complete: false, currentReferences: [], errors: [], unavailable: ["indisponível"], expired: [], notes: [] }).classificacao, CLASSIFICATIONS.UNAVAILABLE);
});

test("somente SEGURO_PARA_EXCLUIR pode ser apagado", async () => {
  let calls = 0;
  const { executed, errors } = await executeApproved([{ ...asset, classificacao: CLASSIFICATIONS.SAFE }, { ...asset, asset_id: "a2", classificacao: CLASSIFICATIONS.REFERENCE }], async () => { calls++; return { confirmed_absent: true }; });
  assert.equal(calls, 1); assert.equal(executed.length, 1); assert.equal(errors.length, 1);
});

test("limite padrão e máximo são respeitados", () => {
  assert.equal(parseCleanupArgs([]).limit, 100);
  assert.equal(parseCleanupArgs(["--limit=500"]).limit, 500);
  assert.throws(() => parseCleanupArgs(["--limit=501"]));
});

test("engine repassa o limite para a validação", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudinary-cleanup-limit-"));
  let received = 0;
  await runCleanup({ root, mode: "dry-run", limit: 37, logger() {}, validateFn: async (directory, limit) => { received = limit; return { auditDir: directory, protectedCount: 282, stage: [], classified: [] }; } });
  assert.equal(received, 37);
});

test("execute revalida imediatamente antes de apagar", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudinary-cleanup-revalidate-"));
  let validations = 0, destroys = 0;
  const validateFn = async directory => { validations++; return { auditDir: directory, protectedCount: 282, stage: [asset], classified: [{ ...asset, classificacao: CLASSIFICATIONS.SAFE }] }; };
  await runCleanup({ root, mode: "execute", validateFn, destroyFn: async () => { destroys++; return { confirmed_absent: true }; }, logger() {} });
  assert.equal(validations, 2); assert.equal(destroys, 1);
});

test("secrets são removidos dos relatórios", () => {
  const serialized = JSON.stringify(redactSecrets({ access_token: "ACCESS-VALUE", nested: { client_secret: "SECRET-VALUE" }, safe: "ok" }));
  assert.doesNotMatch(serialized, /ACCESS-VALUE|SECRET-VALUE/); assert.match(serialized, /\[REDACTED\]/);
});

test("manifesto contém somente os 111 candidatos do estágio 1", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../scripts/data/cloudinary-orphan-stage-1-candidates.json", import.meta.url), "utf8"));
  assert.equal(manifest.length, 111);
  assert.equal(new Set(manifest.map(item => item.asset_id)).size, 111);
  assert.deepEqual(Object.fromEntries(["SEM_ASSOCIACAO_LOCAL", "SOMENTE_TINY", "ML_E_TINY"].map(group => [group, manifest.filter(item => item.grupo === group).length])), { SEM_ASSOCIACAO_LOCAL: 76, SOMENTE_TINY: 28, ML_E_TINY: 7 });
  assert.deepEqual(Object.keys(manifest[0]), ["asset_id", "public_id", "cloud_name", "secure_url", "sku", "grupo", "bytes", "derived_bytes"]);
});
