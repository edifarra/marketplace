import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
