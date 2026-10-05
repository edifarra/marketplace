import { spawnCommand, formatSpawnError } from './smart-command-runner.mjs';
import { migrationsConfirmed } from './smart-deploy-support.mjs';

// One fresh read per confirmation. No cache, fallback snapshot, or automatic retry.
export function confirmLinkedMigrations(versions, { cwd = process.cwd(), spawn = spawnCommand } = {}) {
  const result = spawn('npx', ['--no-install', 'supabase', 'migration', 'list', '--linked', '--output-format', 'json'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: false,
    timeout: 1_200_000, maxBuffer: 8 * 1024 * 1024
  });
  const diagnostic = `exit=${result.status ?? 'null'}, signal=${result.signal ?? 'none'}, stdoutBytes=${Buffer.byteLength(result.stdout || '')}, stderrBytes=${Buffer.byteLength(result.stderr || '')}`;
  if (result.error) throw new Error(`Migration history capture failed (${diagnostic}; ${formatSpawnError(result.error)}).`);
  if (result.status !== 0) throw new Error(`Migration history command failed (${diagnostic}).`);
  try { return migrationsConfirmed(result.stdout, versions); }
  catch (error) {
    // Do not print raw stdout/stderr: CLI output may contain connection information.
    throw new Error(`Migration history confirmation rejected: ${error.message} (${diagnostic}).`);
  }
}
