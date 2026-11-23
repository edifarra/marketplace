import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawnCommand } from './smart-command-runner.mjs';
import { migrationStatus } from './smart-deploy-support.mjs';

export function cliHistoryArgs(version, help, projectRef) {
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? ''))
    throw new Error('Explicit linked Supabase project ref required.');

  const cliVersion = version.trim();

  if (cliVersion === '3.2.0') {
    if (!/--remote\b/.test(help) || !/--output-format\b/.test(help))
      throw new Error('Unvalidated Supabase CLI 3.2.0 capabilities.');

    return ['migration', 'list', '--remote', '--output-format', 'text'];
  }

  if (/^2\.(118|121)\.0$/.test(cliVersion)) {
    if (!/--output-format\b/.test(help) ||
        !/--project-ref\b/.test(help) ||
        !/--linked\b/.test(help))
      throw new Error('Unvalidated Supabase CLI capabilities.');

    return [
      'migration', 'list', '--linked',
      `--project-ref=${projectRef}`,
      '--output-format', 'text'
    ];
  }

  throw new Error('Unvalidated Supabase CLI version.');
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

export function validateOutOfOrderMigrationPlan(history, result) {
  const allowed = '20261123170000';
  const filename = '20261123170000_create_sale_financial_identifiers.sql';

  if (history?.cliVersion !== '3.2.0' ||
      !/^[a-z0-9]{20}$/.test(history.projectRef ?? '') ||
      !Array.isArray(history.pending) ||
      history.pending.length !== 1 ||
      history.pending[0] !== allowed) {
    throw new Error('Out-of-order migration is not explicitly authorized.');
  }

  if (!result || result.error || result.status !== 0 ||
      result.signal || typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string') {
    throw new Error('Supabase migration dry-run failed.');
  }

  const stdout = result.stdout.trim();
  const lines = result.stderr.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const target = /^Target: project .+ \(([a-z0-9]{20})\) \u00b7 production$/
    .exec(lines[0] ?? '');

  if (!target || target[1] !== history.projectRef) {
    throw new Error('Supabase dry-run targets an unexpected project.');
  }

  const expected = [
    'Initialising login role...',
    'DRY RUN: migrations will *not* be pushed to the database.',
    'Would push these migrations:',
    `\u2022 ${filename}`
  ];

  let structuredOutput = false;
  try {
    structuredOutput = isDeepStrictEqual(JSON.parse(stdout), {
      upToDate: false, dryRun: true, migrations: [filename], seeds: [], roles: [],
      message: 'Finished supabase db push.',
      target: { kind: 'linked', project_ref: history.projectRef,
        project_name: /^Target: project (.+) \(/.exec(lines[0])[1], environment: 'production' }
    });
  } catch { /* Only the exact previously validated text or JSON envelope is accepted. */ }
  if ((!structuredOutput && stdout !== 'Finished supabase db push.') ||
      lines.length !== expected.length + 1 ||
      lines.slice(1).some((line, index) => line !== expected[index])) {
    throw new Error('Migration dry-run differs from the authorized plan.');
  }

  return ['db', 'push', '--remote', '--include-all', '--yes'];
}

export function executeValidatedMigration({
  readHistory,
  dryRun,
  apply,
  assertProject,
  linkedProject
}) {
  assertProject();

  const history = readHistory();

  if (history.projectRef !== linkedProject) {
    throw new Error('Supabase migration project mismatch.');
  }

  if (history.pending?.length !== 1 ||
      history.pending[0] !== '20261123170000') {
    throw new Error('Unexpected pending migrations; deployment blocked.');
  }

  const result = dryRun();

  assertProject();

  const approvedArgs = validateOutOfOrderMigrationPlan(history, result);

  assertProject();

  return apply(approvedArgs);
}
