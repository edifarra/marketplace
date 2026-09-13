import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLASSIFICATIONS, applyRequiredSourceFailures, classifyCandidate, executeApproved, fetchWithPolicy, parseCleanupArgs, processCandidateBatch, redactSecrets, requiredSourcesForCandidate, runCleanup } from "../lib/cloudinary-orphan-cleanup.mjs";

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

function evidence() { return { complete: false, currentReferences: [], errors: [], unavailable: [], expired: [], notes: [] }; }

test("SOMENTE_TINY não herda expiração da Shopee sem associação", () => {
  const candidate = { ...asset, grupo: "SOMENTE_TINY", current_marketplaces: [] };
  const state = evidence();
  applyRequiredSourceFailures(candidate, state, "shopee", [{ type: "expired", reason: "token Shopee expirado" }]);
  assert.deepEqual([...requiredSourcesForCandidate(candidate)], ["tiny"]);
  assert.equal(state.expired.length, 0);
});

test("SEM_ASSOCIACAO_LOCAL não exige ML ou Shopee sem associação", () => {
  const candidate = { ...asset, grupo: "SEM_ASSOCIACAO_LOCAL", current_marketplaces: [] };
  const state = evidence();
  applyRequiredSourceFailures(candidate, state, "mercado_livre", [{ type: "expired", reason: "ML expirado" }]);
  applyRequiredSourceFailures(candidate, state, "shopee", [{ type: "expired", reason: "Shopee expirado" }]);
  assert.deepEqual([...requiredSourcesForCandidate(candidate)], []);
  assert.equal(state.expired.length, 0);
});

test("ML_E_TINY exige ML e Tiny, mas não Shopee", () => {
  const candidate = { ...asset, grupo: "ML_E_TINY", current_marketplaces: ["mercado_livre"] };
  assert.deepEqual([...requiredSourcesForCandidate(candidate)].sort(), ["mercado_livre", "tiny"]);
});

test("associação Shopee real mantém bloqueio por token expirado", () => {
  const candidate = { ...asset, current_marketplaces: ["shopee"] };
  const state = evidence();
  applyRequiredSourceFailures(candidate, state, "shopee", [{ type: "expired", reason: "token Shopee expirado" }]);
  assert.equal(classifyCandidate(candidate, state).classificacao, CLASSIFICATIONS.EXPIRED);
});

test("REFERENCIA_ATUAL prevalece sobre token expirado", () => {
  const state = { ...evidence(), currentReferences: [{ fonte: "product_images" }], expired: ["token expirado"] };
  assert.equal(classifyCandidate(asset, state).classificacao, CLASSIFICATIONS.REFERENCE);
});

test("timeout faz no máximo um retry e registra a fonte", async () => {
  let calls = 0;
  const diagnostics = { timeoutsBySource: {} };
  const hangingFetch = (_url, options) => new Promise((resolve, reject) => {
    calls++;
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(() => fetchWithPolicy("https://example.invalid", {}, { source: "Tiny", timeoutMs: 5, retries: 1, fetchImpl: hangingFetch, diagnostics }), /timeout/);
  assert.equal(calls, 2);
  assert.equal(diagnostics.timeoutsBySource.Tiny, 2);
});

test("falha HTTP transitória recebe somente um retry", async () => {
  let calls = 0;
  const fetchImpl = async () => new Response("{}", { status: ++calls === 1 ? 503 : 200 });
  const response = await fetchWithPolicy("https://example.invalid", {}, { source: "Mercado Livre", retries: 1, fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("lote continua depois de candidato com fonte inacessível", async () => {
  const visited = [], failures = [];
  const candidates = [{ asset_id: "1" }, { asset_id: "2" }, { asset_id: "3" }];
  await processCandidateBatch(candidates, async candidate => {
    visited.push(candidate.asset_id);
    if (candidate.asset_id === "2") throw new Error("fonte inacessível");
    return candidate.asset_id;
  }, (candidate, error) => failures.push({ id: candidate.asset_id, message: error.message }));
  assert.deepEqual(visited, ["1", "2", "3"]);
  assert.deepEqual(failures, [{ id: "2", message: "fonte inacessível" }]);
});
