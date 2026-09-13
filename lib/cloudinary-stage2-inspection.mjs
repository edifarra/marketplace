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
