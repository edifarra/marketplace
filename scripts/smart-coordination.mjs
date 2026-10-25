import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

// Stable host/user location: do not let TEMP/TMP or the checkout select a different lock.
const stableTemp = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Temp') : '/tmp';
const userKey = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 20);
export const SMART_LOCK_PATH = path.join(stableTemp, `edifarra-marketplace-${userKey}.lock`);
// One lock per repository and OS user, independent of checkout/cwd.
export function acquireSmartLock(root, { lockPath = SMART_LOCK_PATH, operation = 'deploy' } = {}) {
  const legacy = path.join(root, '.smart-deploy.lock');
  if (fs.existsSync(legacy)) throw new Error('Legacy lock exists; inspect its owner before manual recovery.');
  const owner = { id: randomUUID(), pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), root: fs.realpathSync(root), operation };
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(lockPath); throw error; }
  fs.closeSync(fd);
  return () => {
    // Never remove a replacement owned by somebody else.
    if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).id !== owner.id) throw new Error('Lock ownership changed; refusing removal.');
    fs.unlinkSync(lockPath);
  };
}
export function assertControlRoot(root, configured = process.env.SMART_DEPLOY_CONTROL_ROOT) {
  if (!configured || fs.realpathSync(configured) !== fs.realpathSync(root))
    throw new Error('Execute/confirm must run in the single configured SMART_DEPLOY_CONTROL_ROOT (canonical state/progress workspace).');
}
export function syncDirectory(directory) {
  if (process.platform === 'win32') {
    if (!fs.statSync(directory).isDirectory())
      throw new Error('Expected a valid control directory.');
    return;
  }
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
