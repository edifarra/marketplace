import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnCommand, formatSpawnError } from './smart-command-runner.mjs';

const PGLITE_VERSION = '0.5.8';
export function runSmartTests(files, { root = process.cwd(), env = process.env, temporary = os.tmpdir(), run = spawnCommand, read = file => JSON.parse(fs.readFileSync(file, 'utf8')) } = {}) {
  if (!files.length) return;
  const testEnv = { ...env };
  const execute = (command, args, options = {}) => {
    const result = run(command, args, { cwd: root, stdio: 'inherit', env: testEnv, ...options });
    if (result.error) throw new Error(formatSpawnError(result.error));
    if (result.status !== 0) throw new Error(`Test command failed (${result.status ?? result.signal}).`);
  };
  if (files.some(file => path.basename(file) === 'marketplace-cases-sql.test.mjs')) {
    // Isolated test-only installation: never changes the project lockfile or VPS dependencies.
    const prefix = path.join(temporary, 'marketplace-case-sql-test');
    const packageFile = path.join(prefix, 'node_modules/@electric-sql/pglite/package.json');
    const cached = () => { try { return read(packageFile).version === PGLITE_VERSION; } catch { return false; } };
    if (!cached()) {
      execute('npm', ['install', '--prefix', prefix, '--cache', path.join(temporary, 'marketplace-case-npm-cache'), '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', `@electric-sql/pglite@${PGLITE_VERSION}`]);
      if (!cached()) throw new Error('Test-only PGlite installation could not be verified.');
    }
    testEnv.PGLITE_MODULE = path.join(prefix, 'node_modules/@electric-sql/pglite/dist/index.js');
  }
  // CLI preload only, rather than NODE_OPTIONS: fixture subprocesses use different directories.
  execute(process.execPath, ['--import', 'tsx', '--require', path.join(root, 'scripts/register-server-only.cjs'), '--test', ...files]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runSmartTests(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
