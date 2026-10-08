import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTrailer } from '../scripts/smart-deploy-metadata.mjs';
import { assertDeploymentMetadata } from '../scripts/smart-deploy-support.mjs';

test('missing, duplicated and invalid base trailers fail closed', () => {
  const valid = `Smart-Deploy-Base: ${'a'.repeat(40)}`;
  for (const message of ['subject', `${valid}\n${valid}`, 'Smart-Deploy-Base: arbitrary',
    `Smart-Deploy-Base: ${'a'.repeat(39)}`, `${valid}\nSmart-Deploy-Base: bad`])
    assert.throws(() => parseTrailer(message, 'Smart-Deploy-Base', 40), /exactly one valid/);
  assert.equal(parseTrailer(`subject\n\n${valid}`, 'Smart-Deploy-Base', 40), 'a'.repeat(40));
});

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-commit-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const cli = (name, args = []) => spawnSync(process.execPath,
    [fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url)), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, SMART_DEPLOY_BASE: '' } });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.smart-deploy-state.json\n');
  git(['add', '.']); git(['commit', '-m', 'baseline']);
  const base = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, '.smart-deploy-state.json'), JSON.stringify({ commit: base }));
  return { root, git, cli, base };
}

test('published trailerless commit is rejected early and recovered by a cumulative new commit', context => {
  const { root, git, cli, base } = fixture(context);
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/page.tsx'), 'pending chats');
  git(['add', '.']); git(['commit', '-m', 'published without metadata']);
  const published = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', published]);
  for (const name of ['smart-deploy', 'smart-check']) {
    const result = cli(name, name === 'smart-deploy' ? ['--dry-run'] : []);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /exactly one valid Smart-Deploy-Base/);
  }
  const result = cli('smart-commit', ['-m', 'recover published changes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(['rev-parse', 'HEAD^']), published);
  assert.equal(git(['rev-parse', 'origin/main']), published);
  assertDeploymentMetadata(root, 'HEAD', base);
  const plan = JSON.parse(fs.readFileSync(path.join(root, '.smart-deploy-plan.json')));
  assert.ok(plan.files.includes('app/page.tsx'));
  assert.equal(plan.base, base);
  assert.equal(cli('smart-deploy', ['--dry-run']).status, 0);
  assert.equal(cli('smart-deploy', [`--base=${published}`, '--dry-run']).status, 1);
  assert.equal(git(['show', '-s', '--format=%B', published]), 'published without metadata');
  fs.writeFileSync(path.join(root, 'app/page.tsx'), 'next change');
  git(['add', '.']);
  assert.equal(cli('smart-commit', ['-m', 'next automatic commit']).status, 0);
  assertDeploymentMetadata(root, 'HEAD', base);
});

for (const malformed of ['duplicate', 'invalid', 'wrong-plan']) test(`dry-run rejects ${malformed} metadata before execution`, context => {
  const { root, git, cli } = fixture(context);
  fs.writeFileSync(path.join(root, 'README.md'), 'change'); git(['add', '.']);
  assert.equal(cli('smart-commit', ['-m', 'valid']).status, 0);
  const message = git(['show', '-s', '--format=%B', 'HEAD']);
  const broken = malformed === 'duplicate' ? `${message}\n${message.split('\n').find(line => line.startsWith('Smart-Deploy-Base:'))}`
    : malformed === 'invalid' ? message.replace(/Smart-Deploy-Base: [a-f0-9]+/, 'Smart-Deploy-Base: invalid')
    : message.replace(/Smart-Deploy-Plan: [a-f0-9]+/, `Smart-Deploy-Plan: ${'0'.repeat(64)}`);
  // Fixture-only new commit simulates broken metadata; no published history is amended.
  git(['commit', '--allow-empty', '-m', broken]);
  const result = cli('smart-deploy', ['--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one valid|does not match/);
});

test('automatic commit rejects manual trailers, missing state and unstaged source', context => {
  const { root, git, cli } = fixture(context);
  assert.equal(cli('smart-commit', ['-m', `manual\nSmart-Deploy-Base: ${'a'.repeat(40)}`]).status, 1);
  fs.writeFileSync(path.join(root, 'source.mjs'), 'unstaged');
  assert.equal(cli('smart-commit', ['-m', 'unstaged']).status, 1);
  fs.rmSync(path.join(root, 'source.mjs'));
  fs.rmSync(path.join(root, '.smart-deploy-state.json'));
  const before = git(['rev-parse', 'HEAD']);
  assert.equal(cli('smart-commit', ['-m', 'no state']).status, 1);
  assert.equal(git(['rev-parse', 'HEAD']), before);
});

test('zero-diff requires confirmed state and pending commits preserve metadata validation', context => {
  const { root, git, cli, base } = fixture(context);

  fs.writeFileSync(path.join(root, 'README.md'), 'first change');
  git(['add', '.']);

  const result = cli('smart-commit', ['-m', 'first valid deployment']);
  assert.equal(result.status, 0, result.stderr);

  const target = git(['rev-parse', 'HEAD']);

  fs.writeFileSync(
    path.join(root, '.smart-deploy-state.json'),
    JSON.stringify({ commit: target })
  );

  assert.doesNotThrow(() => assertDeploymentMetadata(root, target, target));
  assert.equal(cli('smart-deploy', ['--dry-run']).status, 0);
  assert.equal(cli('smart-check').status, 0);

  fs.writeFileSync(
    path.join(root, '.smart-deploy-state.json'),
    JSON.stringify({ commit: base })
  );

  assert.throws(
    () => assertDeploymentMetadata(root, target, target),
    /confirmed deployment state/
  );

  fs.writeFileSync(path.join(root, 'README.md'), 'second change');
  git(['add', '.']);
  git(['commit', '-m', 'commit without trailers']);

  const pending = git(['rev-parse', 'HEAD']);

  assert.throws(
    () => assertDeploymentMetadata(root, pending, base),
    /exactly one valid Smart-Deploy-Base/
  );
});