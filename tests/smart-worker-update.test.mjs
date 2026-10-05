import test from 'node:test';
import assert from 'node:assert/strict';
import { updateWorker } from '../scripts/smart-worker-update.mjs';
import { workerCommand } from '../scripts/smart-worker-command.mjs';
const target = 'a'.repeat(40);
test('one SSH call inherits password input and confirms exact completed target', () => {
  let calls = 0;
  assert.equal(updateWorker(target, false, { spawn: (command, args, options) => {
    calls++; assert.equal(command, 'ssh'); assert.equal(args[0], 'root@76.13.239.70');
    assert.deepEqual(options.stdio, ['inherit', 'pipe', 'pipe']); assert.equal(options.shell, false);
    return { status: 0, stdout: `SMART_WORKER_CONNECTED\nSMART_WORKER_START=confirmation\nSMART_WORKER_SHA=${target}\nSMART_WORKER_DONE=confirmation\n`, stderr: '' };
  } }).target, target);
  assert.equal(calls, 1);
});
test('authenticated remote exit 1 reports failed stage without leaking remote streams', () => {
  assert.throws(() => updateWorker(target, false, { spawn: () => ({ status: 1, stdout: 'SMART_WORKER_CONNECTED\nSMART_WORKER_START=clean-checkout\nsecret-password', stderr: 'private-connection-data\nSMART_WORKER_FAILED=clean-checkout:1\n' }) }), error => {
    assert.match(error.message, /remoteStarted=true.*stage=clean-checkout.*FAILED=clean-checkout:1/);
    assert.doesNotMatch(error.message, /secret-password|private-connection-data/); return true;
  });
});
test('transport failure and missing SHA never confirm worker update', () => {
  assert.throws(() => updateWorker(target, false, { spawn: () => ({ status: 255, stdout: '', stderr: 'Permission denied' }) }), /remoteStarted=false.*stage=connection/);
  assert.throws(() => updateWorker(target, false, { spawn: () => ({ status: 0, stdout: 'SMART_WORKER_CONNECTED\n', stderr: '' }) }), /confirmation missing/);
  assert.throws(() => updateWorker(target, false, { spawn: () => ({ status: 0, error: { code: 'ENOBUFS' }, stdout: '', stderr: '' }) }), /captureError=ENOBUFS/);
});
test('stage markers preserve checks before checkout/restart and conditional dependencies', () => {
  const command = workerCommand(target, false);
  const labels = [...command.matchAll(/smart_step '([^']+)' /g)].map(match => match[1]);
  assert.deepEqual(labels, ['workspace', 'clean-checkout', 'main-branch', 'fetch', 'origin-sha', 'ancestor', 'checkout', 'checkout-sha', 'pm2-restart', 'pm2-online', 'final-sha', 'confirmation']);
  assert.doesNotMatch(command, /npm ci/);
  assert.match(workerCommand(target, true), /smart_step 'dependencies'/);
  assert.match(command, /return "\$smart_rc"/);
});
