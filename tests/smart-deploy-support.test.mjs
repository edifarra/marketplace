import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, migrationStatus, migrationsConfirmed, classifyRange, assertCommitPlan } from '../scripts/smart-deploy-support.mjs';
import { PLAN_FILE, planDigest } from '../scripts/smart-deploy-metadata.mjs';
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
test('current CLI JSON distinguishes applied and pending migrations without hardcoded versions or totals', () => {
  const expected = ['001', '01301', '20260102030405'];
  const migrations = expected.map((local, i) => ({ local, remote: i === expected.length - 1 ? '' : local, time: 'official CLI metadata' }));
  const output = JSON.stringify({ migrations, message: 'Migrations listed' });
  assert.deepEqual(migrationStatus(output, expected), {
    localCount: expected.length, remoteCount: expected.length - 1,
    applied: expected.slice(0, -1), pending: expected.slice(-1)
  });
  assert.equal(migrationsConfirmed(output, expected), false);
  migrations.at(-1).remote = expected.at(-1);
  assert.equal(migrationsConfirmed(JSON.stringify({ migrations }), expected), true);
});
test('legacy ASCII and Unicode tables preserve the same status as JSON', () => {
  const expected = ['001', '002'];
  const json = JSON.stringify({ migrations: [{ local: '001', remote: '001' }, { local: '002', remote: '' }] });
  for (const separator of ['|', '│']) {
    const table = `\u001b[32mLocal ${separator} Remote ${separator} Time\u001b[0m\r\n-----+-----+-----\r\n001 ${separator} 001 ${separator} date\r\n002 ${separator} ${separator} date`;
    assert.deepEqual(migrationStatus(table, expected), migrationStatus(json, expected));
  }
});
test('malformed, empty, unsupported and unsuccessful JSON never confirms migrations', () => {
  for (const output of ['{', '[]', '{}', '{"migrations":[]}', '{"migrations":{}}',
    '{"migrations":[{"local":"001"}]}', '{"migrations":[{"local":1,"remote":1}]}',
    '{"migrations":[{"local":"001","remote":null}]}',
    '{"migrations":[{"local":"001","remote":"bad"}]}',
    '{"migrations":[{"local":"","remote":""}]}',
    '{"migrations":[{"local":"001","remote":"001"}],"error":"failed"}']) {
    assert.throws(() => migrationsConfirmed(output, ['001']), /Unrecognized/, output);
  }
  assert.throws(() => migrationsConfirmed('{"migrations":[{"local":"001","remote":"001"}]}', []), /Unrecognized/);
});
test('JSON unknown remote versions, mismatched rows and duplicate histories fail closed', () => {
  const json = migrations => JSON.stringify({ migrations });
  assert.throws(() => migrationsConfirmed(json([{ local: '001', remote: '001' }, { local: '', remote: '999' }]), ['001']), /diverges/);
  assert.throws(() => migrationsConfirmed(json([{ local: '001', remote: '002' }, { local: '002', remote: '001' }]), ['001', '002']), /diverges/);
  assert.throws(() => migrationsConfirmed(json([{ local: '001', remote: '001' }, { local: '001', remote: '' }]), ['001']), /Duplicate/);
  assert.throws(() => migrationsConfirmed(json([{ local: '001', remote: '001' }, { local: '', remote: '001' }]), ['001']), /Duplicate/);
  assert.throws(() => migrationsConfirmed(json([{ local: '001', remote: '001' }]), ['001','002']), /incomplete/);
  assert.throws(() => migrationsConfirmed(json([{ local: '001', remote: '001' }]), ['001','001']), /Unrecognized/);
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
  fs.writeFileSync(path.join(root, 'README.md'), 'final'); git(['add','.']);
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/smart-deploy-prepare.mjs', import.meta.url)), `--base=${base}`], { cwd: root, encoding: 'utf8' });
  const plan = readJson(path.join(root, PLAN_FILE));
  const message = `docs\n\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${planDigest(plan)}`;
  git(['commit','-m', message]);
  assert.equal(classifyRange(root, base, 'HEAD').frontend, frontend);
  assertCommitPlan(root, 'HEAD', base, classifyRange(root, base, 'HEAD'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/smart-vercel-ignore.mjs', import.meta.url))], { cwd: root, encoding: 'utf8', env: { ...process.env, VERCEL_GIT_COMMIT_SHA: git(['rev-parse', 'HEAD']), VERCEL_GIT_COMMIT_MESSAGE: message } });
  assert.equal(result.status, frontend ? 1 : 0, result.stderr);
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/changed.tsx'), 'unplanned'); git(['add','.']); git(['commit','-m', message]);
  assert.throws(() => assertCommitPlan(root, 'HEAD', base, classifyRange(root, base, 'HEAD')), /actual baseline/);
});
