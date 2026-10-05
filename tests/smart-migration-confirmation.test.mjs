import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmLinkedMigrations } from '../scripts/smart-migration-confirmation.mjs';
import { executeDeployment } from '../scripts/smart-deploy-flow.mjs';

const versions = Array.from({ length: 101 }, (_, i) => String(i + 1).padStart(3, '0'));
const history = (pending = false) => JSON.stringify({ migrations: versions.map((local, i) => ({ local, remote: pending && i === 100 ? '' : local, time: local })), message: 'Migrations listed' });
const capture = stdout => ({ status: 0, stdout, stderr: 'Initialising login role...\nConnecting to remote database...\n' });
function fixture(outputs) {
  const calls = [];
  let published = false;
  const io = {
    preflight: async () => {}, validate: async () => {}, confirm: async () => 'DEPLOY', revalidate: async () => {},
    loadProgress: async () => null, saveProgress: async () => {}, isPublished: async () => published,
    confirmMigrations: () => confirmLinkedMigrations(versions, { spawn: (command, args, options) => {
      calls.push('history');
      assert.equal(command, 'npx');
      assert.deepEqual(args, ['--no-install', 'supabase', 'migration', 'list', '--linked', '--output-format', 'json']);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.encoding, 'utf8'); assert.equal(options.shell, false);
      return capture(outputs.shift());
    } }),
    migrate: async () => { calls.push('db push'); },
    push: async () => { calls.push('git push'); published = true; },
    verifyPublished: async () => {}, complete: async () => {}, clearProgress: async () => {}
  };
  return { calls, io, plan: { mode: 'execute', target: 'target', base: 'base', classification: { migration: true } } };
}

for (const next of ['', 'not-json', '{invalid']) test(`previous valid capture never authorizes deployment when fresh capture is ${JSON.stringify(next)}`, async () => {
  // Prior independent read/dry-run is valid; execute must still require its fresh read.
  assert.equal(confirmLinkedMigrations(versions, { spawn: () => capture(history()) }), true);
  const f = fixture([next]);
  await assert.rejects(executeDeployment(f.plan, f.io), /confirmation rejected/);
  assert.deepEqual(f.calls, ['history']); // no db push or publication
});

test('normal 101/101 needs one fresh query and no db push', async () => {
  const f = fixture([history()]); await executeDeployment(f.plan, f.io);
  assert.deepEqual(f.calls, ['history', 'git push']);
});

test('divergent history blocks every write', async () => {
  const f = fixture([history().replace('"remote":"101"', '"remote":"999"')]);
  await assert.rejects(executeDeployment(f.plan, f.io), /diverges/);
  assert.deepEqual(f.calls, ['history']);
});

test('proven pending migration requires a fresh post-migration confirmation', async () => {
  const f = fixture([history(true), history()]); await executeDeployment(f.plan, f.io);
  assert.deepEqual(f.calls, ['history', 'db push', 'history', 'git push']);
});

for (const next of ['', 'invalid']) test(`pending migration followed by ${next || 'empty'} history blocks publication without repeating db push`, async () => {
  const f = fixture([history(true), next]);
  await assert.rejects(executeDeployment(f.plan, f.io), /confirmation rejected/);
  assert.deepEqual(f.calls, ['history', 'db push', 'history']);
});

test('capture error/nonzero exit cannot authorize writes even with valid JSON', () => {
  for (const result of [{ ...capture(history()), status: 1 }, { ...capture(history()), error: new Error('buffer exceeded') }]) {
    assert.throws(() => confirmLinkedMigrations(versions, { spawn: () => result }), /failed/);
  }
});
