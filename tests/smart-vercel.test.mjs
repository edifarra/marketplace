import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDeployment, waitForVercel } from '../scripts/smart-vercel.mjs';
const deployment = state => ({ uid: 'deployment', projectId: 'project', target: 'production', meta: { githubCommitSha: 'sha' }, state, created: 10 });
test('select exact project, environment and SHA', () => {
  const correct = deployment('READY');
  assert.equal(selectDeployment([{ ...correct, projectId: 'other' }, { ...correct, target: 'preview' }, { ...correct, meta: { githubCommitSha: 'other' } }, correct], 'sha', 'project'), correct);
});
test('READY requires detail and production alias confirmation', async () => {
  const result = await waitForVercel({ target: 'sha', projectId: 'project', request: async url => url.startsWith('/v7') ? { deployments: [deployment('READY')] } : { ...deployment('READY'), readyState: 'READY', aliasAssigned: 123 } });
  assert.equal(result, 'deployment');
});
test('reduced detail is bound to the exact deployment ID from the SHA-filtered list', async () => {
  const result = await waitForVercel({ target: 'sha', projectId: 'project', request: async url => url.startsWith('/v7') ? { deployments: [deployment('READY')] } : { id: 'deployment', target: 'production', readyState: 'READY', aliasAssigned: true } });
  assert.equal(result, 'deployment');
});
test('different detail deployment ID cannot confirm success', async () => {
  await assert.rejects(waitForVercel({ target: 'sha', projectId: 'project', request: async url => url.startsWith('/v7') ? { deployments: [deployment('READY')] } : { id: 'other', target: 'production', readyState: 'READY', aliasAssigned: true } }), /exact SHA/);
});
for (const state of ['ERROR', 'CANCELED', 'BLOCKED']) test(`${state} fails`, async () => {
  await assert.rejects(waitForVercel({ target: 'sha', projectId: 'project', request: async () => ({ deployments: [deployment(state)] }) }), new RegExp(state));
});
test('missing deployment times out', async () => {
  let time = 0;
  await assert.rejects(waitForVercel({ target: 'sha', projectId: 'project', request: async () => ({ deployments: [] }), timeoutMs: 20, now: () => time, sleep: async ms => { time += ms; }, log: () => {} }), /timeout/);
});
test('READY without alias fails', async () => {
  let time = 0;
  await assert.rejects(waitForVercel({ target: 'sha', projectId: 'project', timeoutMs: 20, now: () => time, sleep: async ms => { time += ms; }, log: () => {}, request: async url => url.startsWith('/v7') ? { deployments: [deployment('READY')] } : { ...deployment('READY'), readyState: 'READY' } }), /timeout/);
});
