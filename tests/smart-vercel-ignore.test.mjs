import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLAN_FILE, planDigest, classifyPlan } from '../scripts/smart-deploy-metadata.mjs';

const base = 'a'.repeat(40);
const target = 'b'.repeat(40);
function runWithoutGit(context, files, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-no-git-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['smart-vercel-ignore', 'smart-deploy-metadata', 'smart-change-classifier'])
    fs.copyFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), path.join(root, 'scripts', `${name}.mjs`));
  const plan = { schemaVersion: 1, base, files: [...new Set([PLAN_FILE, ...files])].sort(), dependenciesChanged: options.dependencies ?? false };
  if (!options.missingPlan) fs.writeFileSync(path.join(root, PLAN_FILE), options.raw ?? JSON.stringify(plan));
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  const env = { ...process.env, PATH: root, Path: root, VERCEL_GIT_COMMIT_SHA: target,
    VERCEL_GIT_COMMIT_MESSAGE: `corrective commit\n\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${planDigest(plan)}`, ...options.env };
  // No Git binary in PATH and no repository. The real entry point must still work.
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/smart-vercel-ignore.mjs')], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  assert.deepEqual(fs.readdirSync(root).sort(), options.missingPlan ? ['scripts'] : [PLAN_FILE, 'scripts']);
  return { result, plan };
}
for (const [files, frontend] of [
  [['app/page.tsx'], true],
  [['scripts/smart-vercel-ignore.mjs'], true],
  [['supabase/migrations/100_new.sql'], false],
  [['scripts/marketplace-worker.ts'], false],
  [['README.md'], false],
  [['lib/outgoing-activities.ts','supabase/migrations/100_new.sql'], true]
]) test(`without .git: ${files.join(',')}`, context => {
  const { result, plan } = runWithoutGit(context, files);
  assert.equal(classifyPlan(plan).frontend, frontend);
  assert.equal(result.status, frontend ? 1 : 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Verified committed plan/);
  assert.doesNotMatch(result.stdout + result.stderr, /not a git repository|git rev-parse/);
});
test('without .git: dependency changes build', context => {
  const { result } = runWithoutGit(context, ['package.json'], { dependencies: true });
  assert.equal(result.status, 1, result.stderr);
});
for (const [name, options] of [
  ['missing SHA', { env: { VERCEL_GIT_COMMIT_SHA: '' } }],
  ['invalid SHA', { env: { VERCEL_GIT_COMMIT_SHA: '364b312' } }],
  ['missing commit message', { env: { VERCEL_GIT_COMMIT_MESSAGE: '' } }],
  ['truncated message', { env: { VERCEL_GIT_COMMIT_MESSAGE: 'x'.repeat(2048) } }],
  ['missing plan', { missingPlan: true }],
  ['invalid JSON', { raw: '{' }],
  ['tampered plan', { raw: JSON.stringify({ schemaVersion: 1, base, files: [PLAN_FILE, 'app/other.tsx'], dependenciesChanged: false }) }],
  ['invalid schema', { raw: JSON.stringify({ frontend: true }) }],
  ['wrong hash', { env: { VERCEL_GIT_COMMIT_MESSAGE: `commit\n\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${'0'.repeat(64)}` } }],
  ['wrong baseline', { env: { VERCEL_GIT_COMMIT_MESSAGE: `commit\n\nSmart-Deploy-Base: ${target}\nSmart-Deploy-Plan: ${'0'.repeat(64)}` } }],
  ['duplicate baseline', { env: { VERCEL_GIT_COMMIT_MESSAGE: `commit\n\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${'0'.repeat(64)}` } }]
]) test(`without .git fail-closed: ${name}`, context => {
  const { result } = runWithoutGit(context, ['app/page.tsx'], options);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /build blocked/);
});
test('plan hash is independent of checkout newline style', context => {
  const files = [PLAN_FILE, 'app/page.tsx'];
  const raw = JSON.stringify({ schemaVersion: 1, base, files, dependenciesChanged: false }, null, 2).replaceAll('\n', '\r\n');
  assert.equal(runWithoutGit(context, ['app/page.tsx'], { raw }).result.status, 1);
});
test('ignore dependency graph contains no Git or process execution', () => {
  for (const name of ['smart-vercel-ignore', 'smart-deploy-metadata', 'smart-change-classifier']) {
    const source = fs.readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:child_process|(?:from\s*|import\s*\()["'][^"']*(?:smart-git|smart-deploy-support)|\bgit\s*\(|\bfetch\s*\(/);
  }
});
test('missing auxiliary module is fail-closed, not exit 1', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-no-module-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'smart-vercel-ignore.mjs');
  fs.copyFileSync(new URL('../scripts/smart-vercel-ignore.mjs', import.meta.url), entry);
  const result = spawnSync(process.execPath, [entry], { cwd: root, env: { ...process.env, PATH: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build blocked/);
});
