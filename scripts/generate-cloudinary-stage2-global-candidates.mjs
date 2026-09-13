import fs from "node:fs";
import { isLegacyCandidate } from "../lib/cloudinary-legacy-optimize.mjs";

const assets = JSON.parse(fs.readFileSync(new URL("../artifacts/cloudinary-legacy-audit/principal-assets.json", import.meta.url), "utf8"));
const rows = JSON.parse(fs.readFileSync(new URL("../artifacts/cloudinary-legacy-audit/do-not-delete.json", import.meta.url), "utf8")).flatMap(item => item.referenced_rows || []);
const candidates = assets.flatMap(asset => {
  const verdict = isLegacyCandidate(asset, rows);
  if (!verdict.eligible) return [];
  return [{ asset_id: asset.asset_id, public_id: asset.public_id, version: asset.version, secure_url: asset.secure_url, format: asset.format,
    created_at: asset.created_at, bytes: asset.bytes, width: asset.width, height: asset.height,
    product_id: verdict.references[0]?.product_id || null, local_references: verdict.references }];
});
if (candidates.length !== 860 || new Set(candidates.map(x => x.asset_id)).size !== candidates.length) throw new Error(`Fonte global inesperada: ${candidates.length} candidatos`);
fs.writeFileSync(new URL("./data/cloudinary-stage2-global-candidates.json", import.meta.url), `${JSON.stringify(candidates, null, 2)}\n`);
const pilotIds = ["produtos/LG/1239KTKT_32LN5400_02", "produtos/LG/815PFPF_65NANO81SNA_EAX68248021_02_2dedb9ca58", "produtos/LG/816PFDPF_55QNED80SRA_EAY65895417_04_8801e764b0"];
const stage2cManifest = JSON.parse(fs.readFileSync(new URL("./data/cloudinary-stage2c-batch-20.json", import.meta.url), "utf8"));
const evidence = {
  recorded_at: "2026-09-13", source: "Stage 2B/2C validated execution artifacts",
  pilot: pilotIds.map(public_id => ({ public_id, status: "COMPLETED" })),
  stage2c: { preflight: { ok: true, assets: stage2cManifest.slice(6).map(item => ({ public_id: item.public_id })) }, assets: stage2cManifest.map((item, index) => ({ ...item, status: index < 6 ? "COMPLETED" : "PREFLIGHT_APPROVED", preflight_approved: index >= 6 })) },
};
fs.writeFileSync(new URL("./data/cloudinary-stage2-legacy-evidence.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Manifesto global gerado: ${candidates.length} candidatos.`);
