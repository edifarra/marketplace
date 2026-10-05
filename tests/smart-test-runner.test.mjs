import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runSmartTests } from '../scripts/smart-test-runner.mjs';

test('SQL test prepares pinned isolated PGlite and supplies shim without leaking to fixture children', () => {
  const calls = [];
  let installed = false;
  runSmartTests(['tests/marketplace-cases-sql.test.mjs', 'tests/marketplace-case-list.test.ts'], {
    root: process.cwd(), temporary: '/temporary-tests', env: {},
    read: () => { if (!installed) throw new Error('missing'); return { version: '0.5.8' }; },
    run: (command, args, options) => { calls.push({ command, args, env: { ...options.env } }); installed = true; return { status: 0 }; }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'npm');
  assert.ok(calls[0].args.includes('@electric-sql/pglite@0.5.8'));
  assert.ok(calls[0].args.includes('--no-package-lock'));
  assert.ok(calls[1].args.includes(path.join(process.cwd(), 'scripts/register-server-only.cjs')));
  assert.ok(calls[1].env.PGLITE_MODULE.endsWith(path.join('pglite', 'dist', 'index.js')));
  assert.equal(calls[1].env.NODE_OPTIONS, undefined);
});

test('cached SQL runtime avoids installation; non-SQL tests need no PGlite', () => {
  for (const files of [['tests/marketplace-cases-sql.test.mjs'], ['tests/marketplace-case-detail.test.ts']]) {
    const calls = [];
    runSmartTests(files, { env: {}, read: () => ({ version: '0.5.8' }), run: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
  }
});

test('failed automatic SQL setup stops before tests', () => {
  let calls = 0;
  assert.throws(() => runSmartTests(['tests/marketplace-cases-sql.test.mjs'], { read: () => { throw new Error('missing'); }, run: () => { calls++; return { status: 1 }; } }), /failed/);
  assert.equal(calls, 1);
});
