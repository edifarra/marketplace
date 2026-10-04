import assert from 'node:assert/strict';
import test from 'node:test';
import { executeDeployment } from '../scripts/smart-deploy-flow.mjs';

function fixture(c, failAt, options = {}) {
  const calls = [];
  let published = options.published ?? false;
  let migrated = options.applied ?? false;
  let progress = options.progress;
  const io = Object.fromEntries(['preflight', 'validate', 'revalidate', 'verifyPublished', 'updateWorker', 'clearProgress'].map(name => [name, async () => step(name)]));
  function step(name) { calls.push(name); if (name === failAt) throw new Error(`failed ${name}`); }
  Object.assign(io, {
    confirm: async () => { step('confirm'); return options.answer ?? 'DEPLOY'; },
    loadProgress: async () => progress,
    saveProgress: async value => { step('saveProgress'); progress = structuredClone(value); },
    confirmMigrations: async () => { step('confirmMigrations'); return options.neverConfirm ? false : migrated; },
    migrate: async () => { step('migrate'); migrated = true; },
    isPublished: async () => published,
    push: async () => { step('push'); published = true; },
    waitVercel: async () => { step('waitVercel'); return 'deployment'; },
    complete: async state => { step('complete'); assert.equal(state.commit, 'target'); }
  });
  const plan = { mode: options.mode ?? 'execute', target: 'target', base: 'base', classification: c };
  return { calls, io, plan, progress: () => progress };
}
for (const frontend of [false, true]) for (const migration of [false, true]) for (const worker of [false, true]) {
  test(`combination frontend=${frontend} migration=${migration} worker=${worker}`, async () => {
    const f = fixture({ frontend, migration, worker });
    await executeDeployment(f.plan, f.io);
    if (!frontend && !migration && !worker) return assert.deepEqual(f.calls, []);
    assert.equal(f.calls.includes('migrate'), migration);
    assert.equal(f.calls.includes('waitVercel'), frontend);
    assert.equal(f.calls.includes('updateWorker'), worker);
    assert.equal(f.calls.includes('complete'), true);
    if (migration) assert.ok(f.calls.lastIndexOf('confirmMigrations') < f.calls.indexOf('push'));
    if (frontend && worker) assert.ok(f.calls.indexOf('waitVercel') < f.calls.indexOf('updateWorker'));
    assert.ok(f.calls.indexOf('complete') > f.calls.indexOf('push'));
  });
}
for (const failAt of ['preflight', 'validate', 'confirm', 'revalidate', 'confirmMigrations', 'migrate', 'push', 'verifyPublished', 'waitVercel', 'updateWorker', 'complete']) {
  test(`failure ${failAt} stops subsequent actions`, async () => {
    const f = fixture({ frontend: true, migration: true, worker: true }, failAt);
    await assert.rejects(executeDeployment(f.plan, f.io));
    assert.equal(f.calls.at(-1), failAt);
    if (['preflight','validate','confirm','revalidate','confirmMigrations','migrate'].includes(failAt)) assert.equal(f.calls.includes('push'), false);
    if (failAt === 'waitVercel') assert.equal(f.calls.includes('updateWorker'), false);
    if (failAt !== 'complete') assert.equal(f.calls.includes('complete'), false);
  });
}
for (const mode of ['plan', 'dry-run']) test(`${mode} has zero side effects`, async () => {
  const f = fixture({ frontend: true, migration: true, worker: true }, null, { mode });
  await executeDeployment(f.plan, f.io); assert.deepEqual(f.calls, []);
});
test('confirmation cannot be replaced by yes', async () => {
  const f = fixture({ frontend: true }, null, { answer: 'yes' });
  await assert.rejects(executeDeployment(f.plan, f.io), /DEPLOY/);
  assert.equal(f.calls.includes('push'), false);
});
test('migration confirmation failure blocks push', async () => {
  const f = fixture({ migration: true }, null, { neverConfirm: true });
  await assert.rejects(executeDeployment(f.plan, f.io), /confirmation failed/);
  assert.equal(f.calls.includes('push'), false);
});
test('uncontrolled published migration commit is blocked', async () => {
  const f = fixture({ migration: true }, null, { published: true, applied: true });
  await assert.rejects(executeDeployment(f.plan, f.io), /already published/);
});
test('resume after Vercel failure does not repeat migration or push', async () => {
  const first = fixture({ frontend: true, migration: true, worker: true }, 'waitVercel');
  await assert.rejects(executeDeployment(first.plan, first.io));
  const next = fixture(first.plan.classification, null, { published: true, applied: true, progress: first.progress() });
  await executeDeployment(next.plan, next.io);
  assert.equal(next.calls.includes('migrate'), false);
  assert.equal(next.calls.includes('push'), false);
  assert.equal(next.calls.includes('waitVercel'), true);
});
test('unrelated partial deployment blocks execution', async () => {
  const f = fixture({ frontend: true }, null, { progress: { target: 'other', base: 'base' } });
  await assert.rejects(executeDeployment(f.plan, f.io), /another target/);
});
