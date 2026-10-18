import fs from 'node:fs';
import path from 'node:path';
import { spawnCommand } from './smart-command-runner.mjs';
import { migrationStatus } from './smart-deploy-support.mjs';

export function cliHistoryArgs(version, help, projectRef) {
  if (!/^2\.(118|121)\.0$/.test(version.trim()) || !/--output-format\b/.test(help) || !/--project-ref\b/.test(help) || !/--linked\b/.test(help))
    throw new Error('Unvalidated Supabase CLI version/help; capture a local fixture before enabling another version.');
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? '')) throw new Error('Explicit linked Supabase project ref required.');
  // Text is the documented migration table; do not assume the JSON envelope.
  return ['migration', 'list', '--linked', `--project-ref=${projectRef}`, '--output-format', 'text'];
}
export function readLinkedHistory(versions, { cwd = process.cwd(), projectRef, binary = process.env.SMART_SUPABASE_BIN, spawn = spawnCommand } = {}) {
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw new Error('SMART_SUPABASE_BIN must point to an existing validated CLI binary; no npx download.');
  const linkedFile = path.join(cwd, 'supabase/.temp/project-ref');
  const linked = fs.readFileSync(linkedFile, 'utf8').trim();
  projectRef ??= linked;
  if (linked !== projectRef) throw new Error('Explicit Supabase ref differs from linked project.');
  const env = { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  // Reject alternate selection/configuration rather than silently querying another database.
  if (Object.keys(env).some(k => /^(SUPABASE_(?:DB_URL|POSTGRES_URL|WORKDIR|PROFILE|API_URL|PROJECT_HOST|REMOTES_.+))$/.test(k) && env[k]))
    throw new Error('Supabase connection override present; remote project identity is ambiguous.');
  const run = args => {
    const r = spawn(binary, args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error('Supabase local CLI read failed; raw connection output withheld.');
    return r.stdout;
  };
  const version = run(['--version']).trim(), help = run(['migration','list','--help']);
  const status = migrationStatus(run(cliHistoryArgs(version, help, projectRef)), versions);
  if (fs.readFileSync(linkedFile, 'utf8').trim() !== linked) throw new Error('Supabase link changed during read.');
  return { projectRef, cliVersion: version, ...status };
}
export function confirmLinkedMigrations(versions, options = {}) {
  return readLinkedHistory(versions, options).pending.length === 0;
}
