import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, migrationsConfirmed, classifyRange } from '../scripts/smart-deploy-support.mjs';
import { workerCommand } from '../scripts/smart-worker-command.mjs';
test('migration confirmation requires exact local and remote histories', () => {
  assert.equal(migrationsConfirmed('001 | 001 | date\n002 | 002 | date', ['001','002']), true);
  assert.equal(migrationsConfirmed('001 | 001 | date\n002 | | date', ['001','002']), false);
  assert.throws(() => migrationsConfirmed('001 | 001 | date\n | 003 | date', ['001']), /diverges/);
  assert.throws(() => migrationsConfirmed('unknown output', ['001']), /Unrecognized/);
});
test('atomic state replacement leaves no temporary files', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-state-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state.json');
  atomicJson(state, { commit: 'old' }); atomicJson(state, { commit: 'target' });
  assert.deepEqual(readJson(state), { commit: 'target' });
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});
test('failed atomic write preserves previous baseline', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-state-fail-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state.json'); atomicJson(state, { commit: 'old' });
  const value = {}; value.circular = value;
  assert.throws(() => atomicJson(state, value));
  assert.deepEqual(readJson(state), { commit: 'old' });
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});
test('VPS command only installs dependencies when requested and verifies SHA', () => {
  const target = 'a'.repeat(40);
  assert.doesNotMatch(workerCommand(target, false), /npm ci/);
  assert.match(workerCommand(target, true), /npm ci/);
  assert.match(workerCommand(target, false), /merge-base --is-ancestor/);
  assert.match(workerCommand(target, false), /git reset --keep/);
  assert.match(workerCommand(target, false), new RegExp(`SMART_WORKER_SHA=${target}`));
  assert.doesNotMatch(workerCommand(target, true), /git merge |git rebase|--force/);
  assert.throws(() => workerCommand('sha; command', true));
});
for (const frontend of [false, true]) test(`Vercel ignore uses same cumulative classifier frontend=${frontend}`, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-ignore-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = argv => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git(['init', '--initial-branch=main']); git(['config','user.name','Test']); git(['config','user.email','test@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'initial'); git(['add','.']); git(['commit','-m','initial']);
  const base = git(['rev-parse','HEAD']);
  fs.mkdirSync(path.join(root, frontend ? 'app' : 'supabase/migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, frontend ? 'app/page.tsx' : 'supabase/migrations/001_new.sql'), 'new');
  git(['add','.']); git(['commit','-m','first change']);
  // Last commit is docs-only: using HEAD^ would miss a frontend change in the batch.
  fs.writeFileSync(path.join(root, 'README.md'), 'final'); git(['add','.']); git(['commit','-m',`docs\n\nSmart-Deploy-Base: ${base}`]);
  assert.equal(classifyRange(root, base, 'HEAD').frontend, frontend);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/smart-vercel-ignore.mjs', import.meta.url))], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, frontend ? 1 : 0, result.stderr);
});
