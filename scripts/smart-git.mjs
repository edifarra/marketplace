import { execFileSync } from "node:child_process";

export function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

export function changedFiles({ base, head = "HEAD", includeWorkingTree = false, cwd } = {}) {
  const files = new Set();
  const options = cwd ? { cwd } : {};
  if (base) {
    for (const file of lines(git(["diff", "--name-only", "--diff-filter=ACMRD", base, head], options))) files.add(file);
  }
  if (includeWorkingTree) {
    for (const file of lines(git(["diff", "--name-only", "--diff-filter=ACMRD", "HEAD"], options))) files.add(file);
    for (const file of lines(git(["ls-files", "--others", "--exclude-standard"], options))) files.add(file);
  }
  return [...files];
}

export function workingTreeDirty({ cwd } = {}) {
  return Boolean(git(["status", "--porcelain"], cwd ? { cwd } : {}));
}

export function dependencyFilesChanged({ base, head = "HEAD", cwd } = {}) {
  if (!base) return false;
  const files = changedFiles({ base, head, cwd });
  const lockfiles = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
  if (files.some((file) => lockfiles.has(file))) return true;
  if (!files.includes("package.json")) return false;

  const before = packageDependencySections(base, cwd);
  const after = packageDependencySections(head, cwd);
  return stableJson(before) !== stableJson(after);
}

function packageDependencySections(ref, cwd) {
  try {
    const packageJson = JSON.parse(git(["show", `${ref}:package.json`], cwd ? { cwd } : {}));
    return Object.fromEntries(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .map((key) => [key, packageJson[key] ?? {}]));
  } catch {
    return null;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
