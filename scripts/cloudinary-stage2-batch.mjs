import fs from "node:fs";

const EXECUTE_FLAG = "--execute-stage2c-20";
const INSPECT_FLAG = "--inspect-interrupted-stage2c";
const RESUME_FLAG = "--resume-stage2c-remaining-14";
const EXCLUDED = new Set([
  "produtos/LG/1239KTKT_32LN5400_02",
  "produtos/LG/815PFPF_65NANO81SNA_EAX68248021_02_2dedb9ca58",
  "produtos/LG/816PFDPF_55QNED80SRA_EAY65895417_04_8801e764b0",
]);
if (
  process.argv.length !== 3 ||
  ![EXECUTE_FLAG, INSPECT_FLAG, RESUME_FLAG].includes(process.argv[2])
)
  throw new Error(
    `Use exclusivamente ${EXECUTE_FLAG}, ${INSPECT_FLAG} ou ${RESUME_FLAG}.`,
  );
const manifest = JSON.parse(
  fs.readFileSync(
    new URL("./data/cloudinary-stage2c-batch-20.json", import.meta.url),
    "utf8",
  ),
);
if (
  manifest.length !== 20 ||
  new Set(manifest.map((x) => x.asset_id)).size !== 20 ||
  new Set(manifest.map((x) => x.public_id)).size !== 20
)
  throw new Error("Manifesto deve conter exatamente 20 assets únicos.");
if (manifest.some((x) => EXCLUDED.has(x.public_id)))
  throw new Error("Manifesto contém asset já processado na Etapa 2B.");
if (process.argv[2] === INSPECT_FLAG) {
  process.env.STAGE2C_INSPECTION_MANIFEST = JSON.stringify(manifest);
  await import("./cloudinary-stage2-interrupted-inspection.mjs");
  process.exit(0);
}
if (process.argv[2] === RESUME_FLAG) {
  process.env.STAGE2C_INSPECTION_MANIFEST = JSON.stringify(manifest);
  await import("./cloudinary-stage2-interrupted-inspection.mjs");
  const { assertResumeReconciliation } =
    await import("../lib/cloudinary-stage2-inspection.mjs");
  const inspection = JSON.parse(
    fs.readFileSync(
      new URL(
        "../artifacts/cloudinary-stage2-batch/interrupted-inspection.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const remaining = assertResumeReconciliation(inspection, manifest);
  process.env.STAGE2C_RESUME_LAUNCH = "confirmed-exact-remaining-14";
  process.env.STAGE2C_RESUME_MANIFEST = JSON.stringify(remaining);
  process.env.STAGE2C_RESUME_INSPECTION = JSON.stringify(inspection);
  process.argv[2] = "--resume-stage2c-remaining-14-internal";
  await import("./cloudinary-stage2-pilot.mjs");
}
process.env.STAGE2C_BATCH_LAUNCH = "confirmed-exact-20";
process.env.STAGE2C_BATCH_MANIFEST = JSON.stringify(manifest);
process.argv[2] = "--execute-stage2c-20-internal";
await import("./cloudinary-stage2-pilot.mjs");
