import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyInterruptedState } from "../lib/cloudinary-stage2-inspection.mjs";

const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      "../scripts/data/cloudinary-stage2c-batch-20.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const wrapper = fs.readFileSync(
  new URL("../scripts/cloudinary-stage2-batch.mjs", import.meta.url),
  "utf8",
);
const engine = fs.readFileSync(
  new URL("../scripts/cloudinary-stage2-pilot.mjs", import.meta.url),
  "utf8",
);

test("manifesto contém exatamente 20 assets únicos e exclui o piloto 2B", () => {
  assert.equal(manifest.length, 20);
  assert.equal(new Set(manifest.map((item) => item.asset_id)).size, 20);
  assert.equal(new Set(manifest.map((item) => item.public_id)).size, 20);
  assert.equal(
    manifest.every((item) => Number.isInteger(item.original_version)),
    true,
  );
  for (const excluded of [
    "produtos/LG/1239KTKT_32LN5400_02",
    "produtos/LG/815PFPF_65NANO81SNA_EAX68248021_02_2dedb9ca58",
    "produtos/LG/816PFDPF_55QNED80SRA_EAY65895417_04_8801e764b0",
  ]) {
    assert.equal(
      manifest.some((item) => item.public_id === excluded),
      false,
    );
  }
});

test("modo de inspeção exige a flag exata e não alcança o executor", () => {
  assert.match(wrapper, /--inspect-interrupted-stage2c/);
  assert.ok(
    wrapper.indexOf("if (process.argv[2] === INSPECT_FLAG)") <
      wrapper.indexOf("STAGE2C_BATCH_LAUNCH"),
  );
});

test("classificação interrompida exige evidência explícita", () => {
  const base = {
    identityOk: true,
    originalVersion: 10,
    currentVersion: 10,
    currentSha256: "original",
    backupSha256: "original",
    expectedSha256: "optimized",
    optimizedOutputValid: true,
    readValidationOk: true,
  };
  assert.equal(
    classifyInterruptedState({ ...base, backupExists: false }),
    "NOT_STARTED",
  );
  assert.equal(
    classifyInterruptedState({ ...base, backupExists: true }),
    "BACKUP_CREATED_NOT_OVERWRITTEN",
  );
  assert.equal(
    classifyInterruptedState({
      ...base,
      backupExists: true,
      currentVersion: 11,
      currentSha256: "optimized",
    }),
    "OVERWRITTEN_AND_VALID",
  );
  assert.equal(
    classifyInterruptedState({
      ...base,
      backupExists: true,
      optimizedEvidence: true,
    }),
    "ROLLED_BACK",
  );
  assert.equal(
    classifyInterruptedState({
      ...base,
      backupExists: true,
      currentVersion: 11,
      currentSha256: "unknown",
    }),
    "OVERWRITTEN_NEEDS_REVIEW",
  );
});

test("inspeção é somente leitura e gera os dois relatórios", () => {
  const source = fs.readFileSync(
    new URL(
      "../scripts/cloudinary-stage2-interrupted-inspection.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /resources\/restore|image\/upload|upload\(|restore\(|delete\(/,
  );
  assert.doesNotMatch(source, /\.from\([^)]*\)\.(insert|update|delete|upsert)/);
  assert.doesNotMatch(source, /refresh[_-]?token|oauth\/token/i);
  assert.match(source, /interrupted-inspection\.json/);
  assert.match(source, /interrupted-inspection\.md/);
  assert.match(source, /database_writes: 0/);
  assert.match(source, /marketplace_writes: 0/);
  assert.match(source, /cloudinary_writes: 0/);
  assert.match(source, /método externo não permitido no modo somente leitura/);
});

test("executor exige flag exata e handshake interno de 20 assets", () => {
  assert.match(wrapper, /--execute-stage2c-20/);
  assert.match(wrapper, /process\.argv\.length !== 3/);
  assert.match(engine, /confirmed-exact-20/);
  assert.match(engine, /manifest\.length !== 20/);
});

test("lote faz preflight completo antes de criar backups e processa sequencialmente", () => {
  const preflight = engine.indexOf("const prepared = []"),
    backup = engine.indexOf("fs.mkdirSync(BACKUPS"),
    sequential = engine.indexOf("for (const p of prepared)");
  assert.ok(preflight > 0 && preflight < backup && backup < sequential);
});

test("falha pós-overwrite restaura e interrompe sem refresh ou escrita em marketplaces", () => {
  assert.match(
    engine,
    /await restore\(a, asset\.asset_id, native\.version_id\)/,
  );
  assert.match(engine, /throw error/);
  assert.doesNotMatch(engine, /refresh[_-]?token|oauth\/token/i);
  assert.doesNotMatch(
    engine,
    /api\.mercadolibre\.com[^\n]*(POST|PUT|PATCH|DELETE)/,
  );
  assert.doesNotMatch(
    engine,
    /partner\.shopeemobile\.com[^\n]*(POST|PUT|PATCH|DELETE)/,
  );
  assert.doesNotMatch(engine, /\.from\([^)]*\)\.(insert|update|delete|upsert)/);
});

test("relatório contém totais e estados individuais obrigatórios", () => {
  for (const field of [
    "planned",
    "processed",
    "approved",
    "rollbacks",
    "bytes_before",
    "bytes_after",
    "savings_bytes",
    "savings_percent",
    "public_ids",
    "statuses",
  ])
    assert.match(engine, new RegExp(field));
});
