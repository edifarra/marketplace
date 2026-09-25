import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { buildWorkerFileSet, classifyChanges } from "./smart-change-classifier.mjs";
import { deploymentMode, mayModifyExternalEnvironment } from "./smart-execution-policy.mjs";
import { formatSpawnError, spawnCommand } from "./smart-command-runner.mjs";
import { changedFiles, dependencyFilesChanged, git, workingTreeDirty } from "./smart-git.mjs";

const rootDir = process.cwd();
const statePath = path.join(rootDir, ".smart-deploy-state.json");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const execute = args.has("--execute");
const mode = deploymentMode({ execute, dryRun });
const yes = args.has("--yes");
const baseArg = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7);
const savedBase = readState()?.commit;
const base = baseArg || process.env.SMART_DEPLOY_BASE || savedBase || (dryRun ? "HEAD^" : null);

if (!base) fail("No deployment baseline found. Use --base=<commit> for the first deployment.");
if (mode === "plan") console.log("Planning mode: no production action will run. Add --execute to deploy.");

const files = changedFiles({ base, head: "HEAD" });
const dependenciesChanged = dependencyFilesChanged({ base, head: "HEAD" });
const classification = classifyChanges(files, { workerFiles: buildWorkerFileSet(rootDir), dependenciesChanged });
if (workingTreeDirty()) {
  console.warn("WARNING: working tree has local changes; they were not included in this baseline-to-HEAD classification.");
}
printPlan(base, classification);

if (!mayModifyExternalEnvironment(mode)) process.exit(0);
if (!classification.frontend && !classification.worker && !classification.migration) {
  console.log("Nothing needs production deployment.");
  process.exit(0);
}

assertSafeRepository();
if (!yes) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question("Execute exactly these production actions? Type DEPLOY to continue: ");
  prompt.close();
  if (answer !== "DEPLOY") fail("Deployment cancelled.");
}

if (classification.migration) run("npx", ["supabase", "db", "push", "--linked"], "Supabase migrations");
if (classification.frontend) run("npx", ["vercel", "--prod", "--yes"], "Vercel production deployment");
if (classification.worker) {
  const remote = classification.dependencies
    ? "cd /opt/gestao-marketplace && git pull origin main && npm ci && pm2 restart marketplace-worker --update-env && pm2 status marketplace-worker"
    : "cd /opt/gestao-marketplace && git pull origin main && pm2 restart marketplace-worker --update-env && pm2 status marketplace-worker";
  run("ssh", ["root@76.13.239.70", remote], "VPS worker update");
}

fs.writeFileSync(statePath, `${JSON.stringify({ commit: git(["rev-parse", "HEAD"]), deployedAt: new Date().toISOString() }, null, 2)}\n`);
console.log("Deployment completed successfully; baseline updated.");

function printPlan(selectedBase, result) {
  console.log(`\nBaseline: ${selectedBase}`);
  console.log(`Changed files: ${result.files.length}`);
  console.log(`\nFrontend/Vercel: ${yn(result.frontend)}`);
  console.log(`Worker/VPS: ${yn(result.worker)}`);
  console.log(`Dependencies changed: ${yn(result.dependencies)}`);
  console.log(`Migration: ${yn(result.migration)}`);
  console.log("\nActions required:");
  console.log(result.migration ? "✓ Apply Supabase migrations first" : "- Migration not required");
  console.log(result.frontend ? "✓ Deploy frontend to Vercel" : "- Vercel deployment not required");
  console.log(result.worker ? "✓ Update VPS and restart marketplace-worker" : "- VPS update and PM2 restart not required");
  console.log(result.worker && result.dependencies ? "✓ Run npm ci on VPS" : "- npm ci not required");
  if (mode === "dry-run") console.log("\nDRY RUN: no network connection or production change was made.");
}

function assertSafeRepository() {
  if (git(["status", "--porcelain"])) fail("Real deployment requires a clean working tree.");
  if (git(["branch", "--show-current"]) !== "main") fail("Real deployment is allowed only from the main branch.");
  const pushed = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: rootDir });
  if (pushed.status !== 0) fail("HEAD must already be pushed to origin/main before deployment.");
}

function run(command, commandArgs, label) {
  console.log(`\n> ${label}`);
  const result = spawnCommand(command, commandArgs, { cwd: rootDir, stdio: "inherit" });
  if (result.error) {
    fail(`${label} failed to start: ${formatSpawnError(result.error)}. Remaining steps were not executed.`);
  }
  if (result.status !== 0) {
    const detail = result.signal ? `signal=${result.signal}` : `exit code=${result.status}`;
    fail(`${label} failed (${detail}); remaining steps were not executed.`, result.status ?? 1);
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; }
}

function yn(value) { return value ? "YES" : "NO"; }
function fail(message, code = 1) { console.error(`\nERROR: ${message}`); process.exit(code); }
