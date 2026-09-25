import { execFileSync } from "node:child_process";

export function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

export function changedFiles({ base, head = "HEAD", includeWorkingTree = false } = {}) {
  const files = new Set();
  if (base) {
    for (const file of lines(git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`]))) files.add(file);
  }
  if (includeWorkingTree) {
    for (const file of lines(git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]))) files.add(file);
    for (const file of lines(git(["ls-files", "--others", "--exclude-standard"]))) files.add(file);
  }
  return [...files];
}

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
