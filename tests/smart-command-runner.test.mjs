import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { formatSpawnError, resolveCommand, spawnCommand } from "../scripts/smart-command-runner.mjs";

test("Windows npx resolves to npx-cli.js executed by Node without a shell", () => {
  const npmCli = path.join("C:", "node", "node_modules", "npm", "bin", "npm-cli.js");
  const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
  const resolved = resolveCommand("npx", ["supabase", "db", "push", "--linked"], {
    platform: "win32",
    nodePath: "C:\\node\\node.exe",
    env: { npm_execpath: npmCli },
    existsSync: (candidate) => candidate === npxCli
  });

  assert.equal(resolved.file, "C:\\node\\node.exe");
  assert.deepEqual(resolved.args, [npxCli, "supabase", "db", "push", "--linked"]);
  assert.equal(resolved.shell, false);
});

test("Linux command execution remains unchanged", () => {
  assert.deepEqual(resolveCommand("npx", ["--version"], { platform: "linux" }), {
    file: "npx",
    args: ["--version"],
    shell: false
  });
});

test("spawn errors retain message and operating-system code", () => {
  const error = Object.assign(new Error("spawnSync npx.cmd EINVAL"), { code: "EINVAL", errno: -4071, syscall: "spawnSync npx.cmd" });
  assert.equal(formatSpawnError(error), "spawnSync npx.cmd EINVAL (code=EINVAL, errno=-4071, syscall=spawnSync npx.cmd)");
});

test("Windows npx command starts successfully through its JavaScript CLI", { skip: process.platform !== "win32" }, () => {
  const result = spawnCommand("npx", ["--version"], { stdio: "pipe", encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});
