import { spawnCommand } from './smart-command-runner.mjs';
import { workerCommand } from './smart-worker-command.mjs';

export function updateWorker(target, dependencies, { cwd = process.cwd(), spawn = spawnCommand } = {}) {
  const result = spawn('ssh', ['root@76.13.239.70', workerCommand(target, dependencies)], {
    cwd, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', shell: false,
    timeout: 1_200_000, maxBuffer: 8 * 1024 * 1024
  });
  const stdout = result.stdout || '', stderr = result.stderr || '';
  const lines = stdout.split(/\r?\n/);
  const connected = lines.includes('SMART_WORKER_CONNECTED');
  const stage = lines.filter(line => /^SMART_WORKER_START=[a-z-]+$/.test(line)).at(-1)?.slice('SMART_WORKER_START='.length) || 'connection';
  const failure = stderr.split(/\r?\n/).find(line => /^SMART_WORKER_FAILED=[a-z-]+:\d+$/.test(line));
  // Report only our markers and stream sizes; never dump passwords or arbitrary remote output.
  const diagnostic = `exit=${result.status ?? 'null'}, signal=${result.signal ?? 'none'}, remoteStarted=${connected}, stage=${stage}, ${failure || 'no remote failure marker'}, stdoutBytes=${Buffer.byteLength(stdout)}, stderrBytes=${Buffer.byteLength(stderr)}`;
  if (result.error || result.status !== 0) throw new Error(`VPS update failed (${diagnostic}${result.error ? `, captureError=${result.error.code || 'unknown'}` : ''}); remaining steps stopped.`);
  if (!connected || !lines.includes(`SMART_WORKER_SHA=${target}`) || !lines.includes('SMART_WORKER_DONE=confirmation'))
    throw new Error(`VPS SHA confirmation missing (${diagnostic}); remaining steps stopped.`);
  return { target, stage };
}
