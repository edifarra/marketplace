import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function resolveCommand(command, args, {
  platform = process.platform,
  nodePath = process.execPath,
  env = process.env,
  existsSync = fs.existsSync
} = {}) {
  if (platform !== "win32" || !["npm", "npx"].includes(command)) {
    return { file: command, args, shell: false };
  }

  const cliName = command === "npm" ? "npm-cli.js" : "npx-cli.js";
  const cliPath = findNpmCli(cliName, { env, existsSync });
  if (!cliPath) {
    const error = new Error(`Could not locate ${cliName}. Run deploy:smart through npm or ensure Node.js/npm is present in PATH.`);
    error.code = "NPM_CLI_NOT_FOUND";
    throw error;
  }

  return { file: nodePath, args: [cliPath, ...args], shell: false };
}

export function spawnCommand(command, args, options = {}) {
  const {
    platform = process.platform,
    nodePath = process.execPath,
    env = process.env,
    existsSync = fs.existsSync,
    ...spawnOptions
  } = options;

  let resolved;
  try {
    resolved = resolveCommand(command, args, { platform, nodePath, env, existsSync });
  } catch (error) {
    return { status: null, signal: null, error };
  }

  return spawnSync(resolved.file, resolved.args, {
    ...spawnOptions,
    env,
    shell: resolved.shell
  });
}

export function formatSpawnError(error) {
  const details = [
    error?.code != null ? `code=${error.code}` : null,
    error?.errno != null ? `errno=${error.errno}` : null,
    error?.syscall ? `syscall=${error.syscall}` : null
  ].filter(Boolean);
  return `${error?.message ?? String(error)}${details.length ? ` (${details.join(", ")})` : ""}`;
}

function findNpmCli(cliName, { env, existsSync }) {
  if (env.npm_execpath) {
    const fromNpm = path.join(path.dirname(env.npm_execpath), cliName);
    if (existsSync(fromNpm)) return fromNpm;
  }

  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "node_modules", "npm", "bin", cliName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
