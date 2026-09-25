import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedFiles, dependencyFilesChanged, workingTreeDirty } from "../scripts/smart-git.mjs";

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
  commit(repo, "frontend commit");
  const deployScript = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0)), "../scripts/smart-deploy.mjs");

  const output = execFileSync(process.execPath, [deployScript, "--dry-run", "--execute", "--base=HEAD^"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.match(output, /DRY RUN: no network connection or production change was made/);
  assert.equal(fs.existsSync(path.join(repo, ".smart-deploy-state.json")), false);
});

test("package scripts-only change does not count as dependencies", (context) => {
  const repo = fixtureRepository(context);
  write(repo, "package.json", JSON.stringify({ scripts: { test: "node --test", check: "node check.mjs" }, dependencies: { react: "1" } }));
  commit(repo, "scripts only");

  assert.equal(dependencyFilesChanged({ base: "HEAD^", head: "HEAD", cwd: repo }), false);
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

function run(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
