import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  alreadyProcessedPhysicalState,
  assertResumeReconciliation,
  classifyInterruptedState,
  createSigintGuard,
  evaluateDatabaseReferences,
} from "../lib/cloudinary-stage2-inspection.mjs";

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
const inspection = fs.readFileSync(
  new URL(
    "../scripts/cloudinary-stage2-interrupted-inspection.mjs",
    import.meta.url,
  ),
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

test("resume aceita somente seis válidos seguidos dos quatorze não iniciados", () => {
  const assets = manifest.map((item, index) => ({
    ...item,
    state: index < 6 ? "OVERWRITTEN_AND_VALID" : "NOT_STARTED",
  }));
  const report = {
    assets,
    counts: {
      OVERWRITTEN_AND_VALID: 6,
      NOT_STARTED: 14,
      BACKUP_CREATED_NOT_OVERWRITTEN: 0,
      OVERWRITTEN_NEEDS_REVIEW: 0,
      ROLLED_BACK: 0,
    },
  };
  assert.deepEqual(
    assertResumeReconciliation(report, manifest),
    manifest.slice(6),
  );
  assert.throws(
    () =>
      assertResumeReconciliation(
        {
          ...report,
          assets: assets.with(6, {
            ...assets[6],
            state: "OVERWRITTEN_NEEDS_REVIEW",
          }),
        },
        manifest,
      ),
    /estado atual não corresponde/,
  );
});

test("asset TC 1133 usa URL inequívoca sem aceitar identificador conflitante", () => {
  const item = manifest[6],
    product = { id: "product-tc" };
  const assessment = evaluateDatabaseReferences({
    expected: item,
    imageRows: [
      {
        id: "image-tc",
        product_id: product.id,
        cloudinary_asset_id: null,
        cloudinary_public_id: null,
        cloudinary_url: `https://res.cloudinary.com/store/image/upload/v${item.original_version}/${item.public_id}.jpg`,
      },
    ],
    products: [product],
  });
  assert.equal(assessment.state, "CONSISTENT");
  assert.deepEqual(assessment.references[0].matched_by, ["cloudinary_url"]);
  const conflicting = evaluateDatabaseReferences({
    expected: item,
    imageRows: [
      { ...assessment.matchedRows[0], cloudinary_asset_id: "outro-asset" },
    ],
    products: [product],
  });
  assert.equal(conflicting.state, "INCONSISTENT");
});

test("assets 12, 16 e 17 preservam bloqueios NOT_PROVABLE/INCONSISTENT", () => {
  const [asset12, asset16, asset17] = [
    manifest[11],
    manifest[15],
    manifest[16],
  ];
  const missingProduct = evaluateDatabaseReferences({
    expected: asset12,
    imageRows: [
      {
        id: "i12",
        product_id: "missing",
        cloudinary_asset_id: asset12.asset_id,
      },
    ],
    products: [],
  });
  assert.equal(missingProduct.state, "NOT_PROVABLE");
  assert.equal(missingProduct.reason, "produto ausente");
  const conflictingPublicId = evaluateDatabaseReferences({
    expected: asset16,
    imageRows: [
      {
        id: "i16",
        product_id: "p16",
        cloudinary_asset_id: asset16.asset_id,
        cloudinary_public_id: "produtos/outro",
      },
    ],
    products: [{ id: "p16" }],
  });
  assert.equal(conflictingPublicId.state, "INCONSISTENT");
  const ambiguous = evaluateDatabaseReferences({
    expected: asset17,
    imageRows: [
      { id: "i17a", product_id: "p17a", cloudinary_asset_id: asset17.asset_id },
      {
        id: "i17b",
        product_id: "p17b",
        cloudinary_public_id: asset17.public_id,
      },
    ],
    products: [{ id: "p17a" }, { id: "p17b" }],
  });
  assert.equal(ambiguous.state, "INCONSISTENT");
  assert.match(ambiguous.reason, /ambiguidade/);
});

test("SIGINT impede iniciar o próximo asset", () => {
  const guard = createSigintGuard();
  assert.equal(guard.mayStartNext(), true);
  guard.request();
  assert.equal(guard.requested, true);
  assert.equal(guard.mayStartNext(), false);
});

test("seis processados usam somente critérios físicos no resume", () => {
  const valid = alreadyProcessedPhysicalState({
    original_version: 10,
    current_version: 12,
    identity: { same_asset_id: true, same_public_id: true },
    current: { url_accessible: true },
    external_backup: { exists: true },
    native_backup: { exists: true },
  });
  assert.equal(valid.valid, true);
  assert.equal(
    alreadyProcessedPhysicalState({
      ...valid,
      original_version: 10,
      current_version: 10,
    }).valid,
    false,
  );
  assert.match(wrapper, /STAGE2C_RESUME_RECONCILIATION = "true"/);
  assert.match(inspection, /resumeReconciliation && index < 6/);
  assert.match(inspection, /marketplaces e vínculos de banco não exigidos/);
});

test("resume pula seis válidos, limita candidatos e grava checkpoint", () => {
  assert.match(wrapper, /--resume-stage2c-remaining-14/);
  assert.match(wrapper, /--preflight-resume-stage2c-remaining-14/);
  assert.match(wrapper, /assertResumeReconciliation/);
  assert.match(
    wrapper,
    /STAGE2C_RESUME_MANIFEST = JSON\.stringify\(remaining\)/,
  );
  assert.match(engine, /status: "SKIPPED_ALREADY_PROCESSED"/);
  assert.match(engine, /manifest\.length !== 14/);
  assert.match(engine, /if \(RESUME && !interrupt\.mayStartNext\(\)\) break/);
  assert.match(engine, /if \(RESUME\) checkpoint\(\)/);
  assert.match(engine, /resume-checkpoint\.json/);
  assert.match(engine, /databaseAssessment\.state !== "CONSISTENT"/);
  assert.match(
    engine,
    /PASS: reconciliação e preflight dos 14 concluídos sem escrita externa/,
  );
  assert.ok(
    engine.indexOf("const prepared = []") <
      engine.indexOf("fs.mkdirSync(BACKUPS"),
  );
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
