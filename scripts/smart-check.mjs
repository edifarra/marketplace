import { spawnSync } from "node:child_process";
import process from "node:process";
import { buildWorkerFileSet, classifyChanges, findRelatedTests } from "./smart-change-classifier.mjs";
import { changedFiles } from "./smart-git.mjs";

const rootDir = process.cwd();
const args = new Set(process.argv.slice(2));
const baseArg = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7);
const files = changedFiles({ base: baseArg, includeWorkingTree: true });
const workerFiles = buildWorkerFileSet(rootDir);
const classification = classifyChanges(files, { workerFiles });
const relatedTests = findRelatedTests(rootDir, files);

console.log(`Changed files: ${files.length}`);
if (args.has("--verbose")) files.forEach((file) => console.log(`  ${file}`));

const commands = [];
if (relatedTests.length) commands.push(["npx", ["tsx", "--test", ...relatedTests], `Targeted tests (${relatedTests.length})`]);
if (classification.typecheck) commands.push(["npm", ["run", "typecheck"], "Typecheck"]);
if (classification.build) commands.push(["npm", ["run", "build"], "Build (configuration or dependencies changed)"]);

if (!commands.length) {
  console.log("No code validation required for the detected changes.");
  process.exit(0);
}

for (const [command, commandArgs, label] of commands) {
  console.log(`\n> ${label}`);
  const executable = process.platform === "win32" ? `${command}.cmd` : command;
  const result = spawnSync(executable, commandArgs, { cwd: rootDir, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nSmart check passed.");
