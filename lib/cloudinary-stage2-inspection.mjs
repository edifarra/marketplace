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

export function databaseReferencesProven(item, rows) {
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        String(row.cloudinary_asset_id || "") === String(item.asset_id) &&
        String(row.cloudinary_public_id || "") === String(item.public_id),
    )
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
