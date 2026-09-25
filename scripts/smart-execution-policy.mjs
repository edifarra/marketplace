export function deploymentMode({ execute = false, dryRun = false } = {}) {
  if (dryRun) return "dry-run";
  if (execute) return "execute";
  return "plan";
}

export function mayModifyExternalEnvironment(mode) {
  return mode === "execute";
}
