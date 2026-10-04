import assert from 'node:assert/strict';
import test from 'node:test';
import { createVercelReader, EXPECTED_VERCEL_PROJECT as project } from '../scripts/smart-vercel-auth.mjs';
import { waitForVercel } from '../scripts/smart-vercel.mjs';
const endpoint = `/v9/projects/${project.projectId}`;
const info = { id: project.projectId, accountId: project.orgId, name: project.projectName };
test('authenticated CLI without VERCEL_TOKEN reads project and monitors exact SHA', async () => {
  const calls = [];
  const sha = 'a'.repeat(40);
  const d = { uid: 'dpl_test', projectId: project.projectId, target: 'production', meta: { githubCommitSha: sha }, state: 'READY' };
  const request = createVercelReader({ project, token: '', env: {}, spawn: (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'npx');
    assert.equal(options.timeout, 30_000);
    assert.deepEqual(options.stdio, ['ignore','pipe','pipe']);
    assert.ok(args.includes('--non-interactive'));
    assert.equal(args[args.indexOf('--scope') + 1], project.orgId);
    assert.match(args[3], new RegExp(`teamId=${project.orgId}`));
    const data = args[3].startsWith('/v9') ? info : args[3].startsWith('/v7') ? { deployments: [d] } : { ...d, id: 'dpl_test', readyState: 'READY', aliasAssigned: true };
    return { status: 0, stdout: JSON.stringify(data) };
  }, fetchImpl: () => { throw new Error('No direct fetch for CLI authentication'); } });
  await request(endpoint);
  assert.equal(await waitForVercel({ target: sha, projectId: project.projectId, request }), 'dpl_test');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => !args.includes('--token')));
});
test('explicit CI token uses header only and does not invoke CLI', async () => {
  const request = createVercelReader({ project, token: 'test-only-placeholder', spawn: () => { throw new Error('CLI must not run'); }, fetchImpl: async (url, options) => {
    assert.equal(url.searchParams.get('teamId'), project.orgId);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-only-placeholder');
    return { ok: true, json: async () => info };
  } });
  assert.deepEqual(await request(endpoint), info);
});
test('no authentication is fail-closed and credential-containing output is discarded', async () => {
  const request = createVercelReader({ project, token: '', spawn: () => ({ status: 1, stderr: 'test-sensitive-credential', stdout: 'test-sensitive-credential' }) });
  await assert.rejects(request(endpoint), error => /CLI authentication/.test(error.message) && !error.message.includes('test-sensitive-credential'));
});
for (const bad of [null, {}, { ...project, projectName: 'other' }, { ...project, projectId: 'prj_wrong' }, { ...project, orgId: 'team_wrong' }]) test('missing/incorrect local link blocks before any request', () => {
  assert.throws(() => createVercelReader({ project: bad, spawn: () => assert.fail('must not execute') }), /identity/);
});
for (const bad of [{ ...info, id: 'prj_wrong' }, { ...info, accountId: 'team_wrong' }, { ...info, name: 'other' }]) test('authenticated remote org/project mismatch is blocked', async () => {
  const request = createVercelReader({ project, token: '', spawn: () => ({ status: 0, stdout: JSON.stringify(bad) }) });
  await assert.rejects(request(endpoint), /differs/);
});
test('invalid explicit token never falls back to a different CLI identity', async () => {
  const request = createVercelReader({ project, token: 'test-only-placeholder', spawn: () => assert.fail(), fetchImpl: async () => { throw new Error('test-only-placeholder'); } });
  await assert.rejects(request(endpoint), error => /token authentication/.test(error.message) && !error.message.includes('test-only-placeholder'));
});
test('invalid JSON and API errors are fail-closed without echoing output', async () => {
  for (const stdout of ['test-sensitive-credential', '{"error":"test-sensitive-credential"}']) {
    const request = createVercelReader({ project, token: '', spawn: () => ({ status: 0, stdout }) });
    await assert.rejects(request(endpoint), error => !error.message.includes('test-sensitive-credential'));
  }
});
test('reader rejects arbitrary hosts and endpoints', async () => {
  const request = createVercelReader({ project, token: '', spawn: () => assert.fail() });
  await assert.rejects(request('https://example.com/v9/projects/other'), /Unsupported/);
  await assert.rejects(request('/v2/user'), /Unsupported/);
});
