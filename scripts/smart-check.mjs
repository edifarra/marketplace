import { spawnCommand } from "./smart-command-runner.mjs";
import process from "node:process";
import { buildWorkerFileSet, classifyChanges, findRelatedTests } from "./smart-change-classifier.mjs";
import { changedFiles, git, workingTreeDirty } from "./smart-git.mjs";
import { assertDeploymentMetadata, readJson } from './smart-deploy-support.mjs';

const rootDir = process.cwd();
const args = new Set(process.argv.slice(2));
const baseArg = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7);
try {
  if (workingTreeDirty()) {
    console.log('Working tree validation only: deployment metadata must be checked after committing with npm run commit:smart.');
  } else {
    const base = baseArg || process.env.SMART_DEPLOY_BASE || readJson('.smart-deploy-state.json')?.commit;
    if (!base) throw new Error('Deployment baseline required for committed metadata validation.');
    assertDeploymentMetadata(rootDir, git(['rev-parse', 'HEAD']), git(['rev-parse', `${base}^{commit}`]));
    console.log('Committed deployment metadata verified.');
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
const files = changedFiles({ base: baseArg, includeWorkingTree: true });
const workerFiles = buildWorkerFileSet(rootDir);
const classification = classifyChanges(files, { workerFiles });
const relatedTests = findRelatedTests(rootDir, files);

console.log(`Changed files: ${files.length}`);
if (args.has("--verbose")) files.forEach((file) => console.log(`  ${file}`));

const commands = [];
if (relatedTests.length) commands.push([process.execPath, ["scripts/smart-test-runner.mjs", ...relatedTests], `Targeted tests (${relatedTests.length})`]);
if (classification.typecheck) commands.push(["npm", ["run", "typecheck"], "Typecheck"]);
if (classification.build) commands.push(["npm", ["run", "build"], "Build (configuration or dependencies changed)"]);

if (!commands.length) {
  console.log("No code validation required for the detected changes.");
  process.exit(0);
}

for (const [command, commandArgs, label] of commands) {
  console.log(`\n> ${label}`);
  const result = spawnCommand(command, commandArgs, { cwd: rootDir, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nSmart check passed.");
