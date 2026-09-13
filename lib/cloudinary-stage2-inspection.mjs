export const INTERRUPTED_STATES = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  BACKUP_CREATED_NOT_OVERWRITTEN: "BACKUP_CREATED_NOT_OVERWRITTEN",
  OVERWRITTEN_AND_VALID: "OVERWRITTEN_AND_VALID",
  OVERWRITTEN_NEEDS_REVIEW: "OVERWRITTEN_NEEDS_REVIEW",
  ROLLED_BACK: "ROLLED_BACK",
});

export function classifyInterruptedState(input) {
  const {
    identityOk,
    originalVersion,
    currentVersion,
    backupExists,
    backupSha256,
    currentSha256,
    expectedSha256,
    optimizedEvidence = false,
    optimizedOutputValid = false,
    readValidationOk = false,
  } = input;
  if (!identityOk || !currentVersion || !currentSha256)
    return INTERRUPTED_STATES.OVERWRITTEN_NEEDS_REVIEW;
  if (!backupExists) {
    return Number(currentVersion) === Number(originalVersion)
      ? INTERRUPTED_STATES.NOT_STARTED
      : INTERRUPTED_STATES.OVERWRITTEN_NEEDS_REVIEW;
  }
  if (!backupSha256) return INTERRUPTED_STATES.OVERWRITTEN_NEEDS_REVIEW;
  if (currentSha256 === backupSha256) {
    return optimizedEvidence
      ? INTERRUPTED_STATES.ROLLED_BACK
      : INTERRUPTED_STATES.BACKUP_CREATED_NOT_OVERWRITTEN;
  }
  if (
    Number(currentVersion) > Number(originalVersion) &&
    expectedSha256 &&
    currentSha256 === expectedSha256 &&
    optimizedOutputValid &&
    readValidationOk
  )
    return INTERRUPTED_STATES.OVERWRITTEN_AND_VALID;
  return INTERRUPTED_STATES.OVERWRITTEN_NEEDS_REVIEW;
}

export function assertResumeReconciliation(report, manifest) {
  if (!report || !Array.isArray(report.assets) || manifest.length !== 20)
    throw new Error("reconciliação Stage 2C ausente ou inválida");
  const expected = report.assets.every((asset, index) =>
    index < 6
      ? asset.state === INTERRUPTED_STATES.OVERWRITTEN_AND_VALID
      : asset.state === INTERRUPTED_STATES.NOT_STARTED,
  );
  const counts = report.counts || {};
  if (
    !expected ||
    counts.OVERWRITTEN_AND_VALID !== 6 ||
    counts.NOT_STARTED !== 14 ||
    counts.BACKUP_CREATED_NOT_OVERWRITTEN !== 0 ||
    counts.OVERWRITTEN_NEEDS_REVIEW !== 0 ||
    counts.ROLLED_BACK !== 0
  )
    throw new Error(
      "estado atual não corresponde exatamente a 6 válidos e 14 não iniciados",
    );
  return manifest.slice(6);
}

export function alreadyProcessedPhysicalState(asset) {
  const currentVersion = Number(asset.current_version),
    originalVersion = Number(asset.original_version);
  const checks = {
    version_advanced:
      Number.isFinite(currentVersion) &&
      Number.isFinite(originalVersion) &&
      currentVersion !== originalVersion,
    asset_id_preserved: asset.identity?.same_asset_id === true,
    public_id_preserved: asset.identity?.same_public_id === true,
    current_url_accessible: asset.current?.url_accessible === true,
    external_backup_exists: asset.external_backup?.exists === true,
    native_backup_exists: asset.native_backup?.exists === true,
  };
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    failed: Object.entries(checks)
      .filter(([, valid]) => !valid)
      .map(([name]) => name),
  };
}

/**
 * Fonte única da prova de referência do Stage 2C.
 * - product_images: exige uma correspondência inequívoca por asset_id, public_id
 *   ou public_id extraído da URL; qualquer identificador preenchido e conflitante
 *   torna o conjunto INCONSISTENT.
 * - products: exige exatamente um produto pai para o único product_id encontrado.
 * - listings + product_marketplaces: quando há listing de um marketplace, exige
 *   a relação de leitura correspondente em product_marketplaces.
 */
export function evaluateDatabaseReferences({
  expected,
  imageRows,
  products,
  marketplaceLinks = [],
  listings = [],
}) {
  const publicId = normalizePublicId(expected.public_id);
  const signals = (row) => ({
    asset_id:
      String(row.cloudinary_asset_id || "") === String(expected.asset_id),
    public_id: normalizePublicId(row.cloudinary_public_id) === publicId,
    cloudinary_url:
      publicIdFromUrl(row.cloudinary_url) === publicId ||
      publicIdFromUrl(row.url) === publicId,
  });
  const matchedRows = imageRows.filter((row) =>
    Object.values(signals(row)).some(Boolean),
  );
  const result = (state, reason) => ({
    state,
    reason,
    matchedRows,
    references: matchedRows.map((row) => ({
      id: row.id,
      product_id: row.product_id,
      position: row.position,
      matched_by: Object.entries(signals(row))
        .filter(([, matched]) => matched)
        .map(([field]) => field),
    })),
    tables: ["product_images", "products", "product_marketplaces", "listings"],
  });
  if (!matchedRows.length)
    return result(
      DATABASE_REFERENCE_STATES.NOT_PROVABLE,
      "registro product_images ausente",
    );
  const productIds = new Set(
    matchedRows.map((row) => String(row.product_id || "")).filter(Boolean),
  );
  if (productIds.size !== 1)
    return result(
      DATABASE_REFERENCE_STATES.INCONSISTENT,
      "ambiguidade de múltiplos registros product_images",
    );
  for (const row of matchedRows) {
    if (
      row.cloudinary_asset_id &&
      String(row.cloudinary_asset_id) !== String(expected.asset_id)
    )
      return result(
        DATABASE_REFERENCE_STATES.INCONSISTENT,
        "cloudinary_asset_id não corresponde ao asset esperado",
      );
    if (
      row.cloudinary_public_id &&
      normalizePublicId(row.cloudinary_public_id) !== publicId
    )
      return result(
        DATABASE_REFERENCE_STATES.INCONSISTENT,
        "cloudinary_public_id não corresponde ao public_id esperado",
      );
  }
  const productId = [...productIds][0],
    matchingProducts = products.filter(
      (product) => String(product.id) === productId,
    );
  if (matchingProducts.length !== 1)
    return result(
      DATABASE_REFERENCE_STATES.NOT_PROVABLE,
      matchingProducts.length ? "produto ambíguo" : "produto ausente",
    );
  const productListings = listings.filter(
    (listing) => String(listing.product_id) === productId,
  );
  for (const listing of productListings) {
    const hasLink = marketplaceLinks.some(
      (link) =>
        String(link.product_id) === productId &&
        link.marketplace === listing.marketplace,
    );
    if (!hasLink)
      return result(
        DATABASE_REFERENCE_STATES.NOT_PROVABLE,
        `relação product_marketplaces ausente para ${listing.marketplace}`,
      );
  }
  return result(
    DATABASE_REFERENCE_STATES.CONSISTENT,
    "referência inequívoca e sem identificadores conflitantes",
  );
}

export function createSigintGuard() {
  let requested = false;
  return {
    request() {
      requested = true;
    },
    get requested() {
      return requested;
    },
    mayStartNext() {
      return !requested;
    },
  };
}
import {
  normalizePublicId,
  publicIdFromUrl,
} from "./cloudinary-legacy-optimize.mjs";

export const DATABASE_REFERENCE_STATES = Object.freeze({
  CONSISTENT: "CONSISTENT",
  INCONSISTENT: "INCONSISTENT",
  NOT_PROVABLE: "NOT_PROVABLE",
});
