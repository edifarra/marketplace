import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from 'node:url';
import { planDigest } from '../scripts/smart-deploy-metadata.mjs';
import { changedFiles, dependencyFilesChanged, workingTreeDirty, assertDeploymentRepository } from "../scripts/smart-git.mjs";

test('repository gate accepts equality/ahead and rejects behind/divergence', context => {
  const repo = fixtureRepository(context);
  const base = run(repo, ['rev-parse', 'HEAD']).trim();
  run(repo, ['update-ref', 'refs/remotes/origin/main', base]);
  assertDeploymentRepository({ cwd: repo, target: base, remote: true });
  write(repo, 'README.md', 'new'); commit(repo, 'ahead');
  const target = run(repo, ['rev-parse', 'HEAD']).trim();
  assertDeploymentRepository({ cwd: repo, target, remote: true });
  assert.throws(() => assertDeploymentRepository({ cwd: repo, target: base }), /HEAD changed/);
  run(repo, ['checkout', '-b', 'other']); write(repo, 'other.txt', 'other'); commit(repo, 'remote ahead');
  const ahead = run(repo, ['rev-parse', 'HEAD']).trim();
  run(repo, ['checkout', 'main']); run(repo, ['update-ref', 'refs/remotes/origin/main', ahead]);
  assert.throws(() => assertDeploymentRepository({ cwd: repo, target, remote: true }), /ahead or divergent/);
  write(repo, 'main.txt', 'main'); commit(repo, 'diverge');
  assert.throws(() => assertDeploymentRepository({ cwd: repo, target: run(repo, ['rev-parse', 'HEAD']).trim(), remote: true }), /ahead or divergent/);
});
test('repository gate rejects dirty, wrong branch and missing remote', context => {
  const repo = fixtureRepository(context);
  const target = run(repo, ['rev-parse', 'HEAD']).trim();
  assert.throws(() => assertDeploymentRepository({ cwd: repo, target, remote: true }));
  write(repo, 'dirty.txt', 'dirty');
  assert.throws(() => assertDeploymentRepository({ cwd: repo, target }), /Clean/);
  fs.unlinkSync(path.join(repo, 'dirty.txt'));
  run(repo, ['checkout', '-b', 'other']);
  assert.throws(() => assertDeploymentRepository({ cwd: repo, target }), /main/);
});

test("baseline diff ignores modified and untracked working-tree files", (context) => {
  const repo = fixtureRepository(context);
  write(repo, "app/page.tsx", "export default 'committed';\n");
  write(repo, "package.json", JSON.stringify({ scripts: { test: "node --test", check: "node check.mjs" }, dependencies: { react: "1" } }));
  commit(repo, "feature commit");

  write(repo, "worker/dirty.ts", "export const dirty = true;\n");
  write(repo, "package-lock.json", "{\"lockfileVersion\":3}\n");

  assert.deepEqual(changedFiles({ base: "HEAD^", head: "HEAD", cwd: repo }).sort(), ["app/page.tsx", "package.json"]);
  assert.equal(workingTreeDirty({ cwd: repo }), true);
});

test("actual dry-run CLI does not write deployment state or execute production actions", (context) => {
  const repo = fixtureRepository(context);
  write(repo, "app/page.tsx", "export default 'committed';\n");
  commitPrepared(repo, "frontend commit");
  const deployScript = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0)), "../scripts/smart-deploy.mjs");

  const output = execFileSync(process.execPath, [deployScript, "--dry-run", "--execute", "--yes", "--base=HEAD^"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.match(output, /DRY RUN: no network connection or production change was made/);
  assert.equal(fs.existsSync(path.join(repo, ".smart-deploy-state.json")), false);
  assert.equal(fs.existsSync(path.join(repo, ".smart-deploy-progress.json")), false);
  assert.equal(fs.existsSync(path.join(repo, ".smart-deploy.lock")), false);
});

test("package scripts-only change does not count as dependencies", (context) => {
  const repo = fixtureRepository(context);
  write(repo, "package.json", JSON.stringify({ scripts: { test: "node --test", check: "node check.mjs" }, dependencies: { react: "1" } }));
  commit(repo, "scripts only");

  assert.equal(dependencyFilesChanged({ base: "HEAD^", head: "HEAD", cwd: repo }), false);
});
test('dry-run reports pending migrations from a read-only CLI JSON snapshot and cannot use it for execution', context => {
  const repo = fixtureRepository(context);
  const versions = ['001', '002'];
  for (const version of versions) write(repo, `supabase/migrations/${version}_example.sql`, '-- fixture');
  commitPrepared(repo, 'migrations');
  const snapshot = path.join(repo, 'history.json');
  const history = JSON.stringify({ migrations: versions.map((local, i) => ({ local, remote: i ? '' : local, time: 'date' })) });
  fs.writeFileSync(snapshot, history);
  const deployScript = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0)), '../scripts/smart-deploy.mjs');
  const output = execFileSync(process.execPath, [deployScript, '--dry-run', '--base=HEAD^', `--migration-history=${snapshot}`], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe']
  });
  assert.match(output, /"localCount": 2/); assert.match(output, /"remoteCount": 1/);
  assert.match(output, /"pendingCount": 1/); assert.match(output, /"pending": \[\s*"002"\s*\]/);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), history);
  for (const file of ['.smart-deploy-state.json', '.smart-deploy-progress.json', '.smart-deploy.lock']) {
    assert.equal(fs.existsSync(path.join(repo, file)), false);
  }
  for (const args of [[], ['--execute']]) {
    assert.throws(() => execFileSync(process.execPath, [deployScript, ...args, `--migration-history=${snapshot}`], {
      cwd: repo, stdio: ['ignore','pipe','pipe']
    }), error => String(error.stderr).includes('supported only in dry-run mode'));
  }
});

test("real dependency change requires installation", (context) => {
  const repo = fixtureRepository(context);
  write(repo, "package.json", JSON.stringify({ scripts: { test: "node --test" }, dependencies: { react: "2" } }));
  commit(repo, "dependency update");

  assert.equal(dependencyFilesChanged({ base: "HEAD^", head: "HEAD", cwd: repo }), true);
});

test("committed lockfile change requires installation but untracked lockfile does not", (context) => {
  const repo = fixtureRepository(context);
  write(repo, "README.md", "second commit\n");
  commit(repo, "docs");
  write(repo, "package-lock.json", "{\"lockfileVersion\":3}\n");
  assert.equal(dependencyFilesChanged({ base: "HEAD^", head: "HEAD", cwd: repo }), false);

  commit(repo, "lockfile");
  assert.equal(dependencyFilesChanged({ base: "HEAD^", head: "HEAD", cwd: repo }), true);
});

function fixtureRepository(context) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "smart-deploy-test-"));
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  run(repo, ["init", "--initial-branch=main"]);
  run(repo, ["config", "user.email", "smart-deploy@example.invalid"]);
  run(repo, ["config", "user.name", "Smart Deploy Test"]);
  write(repo, "package.json", JSON.stringify({ scripts: { test: "node --test" }, dependencies: { react: "1" } }));
  write(repo, "app/page.tsx", "export default 'initial';\n");
  write(repo, "worker/dirty.ts", "export const dirty = false;\n");
  commit(repo, "initial");
  return repo;
}

function write(repo, relativePath, contents) {
  const destination = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function commit(repo, message) {
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", message]);
}

function commitPrepared(repo, message) {
  const base = run(repo, ['rev-parse', 'HEAD']).trim();
  run(repo, ['add', '.']);
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/smart-deploy-prepare.mjs', import.meta.url)), `--base=${base}`], { cwd: repo, stdio: 'pipe' });
  const plan = JSON.parse(fs.readFileSync(path.join(repo, '.smart-deploy-plan.json'), 'utf8'));
  run(repo, ['commit', '-m', `${message}\n\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${planDigest(plan)}`]);
}

function run(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
