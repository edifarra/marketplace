import { spawnCommand } from './smart-command-runner.mjs';

export const EXPECTED_VERCEL_PROJECT = Object.freeze({
  projectName: 'marketplace',
  projectId: 'prj_e21vdAeSn0hKztQyc25wrgVtMgUs',
  orgId: 'team_A9TQojzKRvDs6VvK1ZAhtc2s'
});
export function assertLinkedVercelProject(project) {
  if (!project || Object.entries(EXPECTED_VERCEL_PROJECT).some(([key, value]) => project[key] !== value))
    throw new Error('Link the expected marketplace project and team; linked Vercel identity is missing or divergent.');
}
export function assertRemoteVercelIdentity(info) {
  const expected = EXPECTED_VERCEL_PROJECT;
  if (info?.id !== expected.projectId || info?.name !== expected.projectName || info?.accountId !== expected.orgId)
    throw new Error('Authenticated Vercel project/team differs from the expected marketplace identity.');
}
export function createVercelReader({ project, cwd, token = process.env.VERCEL_TOKEN,
  spawn = spawnCommand, fetchImpl = fetch, env = process.env }) {
  assertLinkedVercelProject(project);
  const { projectId, orgId } = EXPECTED_VERCEL_PROJECT;
  return async endpoint => {
    const url = new URL(endpoint, 'https://api.vercel.com');
    const allowed = url.origin === 'https://api.vercel.com' && (
      url.pathname === `/v9/projects/${projectId}` ||
      (url.pathname === '/v7/deployments' && url.searchParams.get('projectId') === projectId) ||
      /^\/v13\/deployments\/dpl_[a-zA-Z0-9]+$/.test(url.pathname));
    if (!allowed) throw new Error('Unsupported Vercel read endpoint.');
    url.searchParams.set('teamId', orgId);
    let data;
    if (token) {
      // Token stays in the HTTPS header: never in argv, logs or state files.
      try {
        const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error('HTTP failure');
        data = await response.json();
      } catch { throw new Error('Vercel token authentication/read failed; remaining actions stopped.'); }
    } else {
      // CLI resolves its own persisted login. Do not read/copy its credential files.
      let result;
      try {
        result = spawn('npx', ['--no-install', 'vercel', 'api', url.pathname + url.search,
          '--method', 'GET', '--raw', '--scope', orgId, '--non-interactive'], {
          cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000
        });
      } catch { throw new Error('Vercel CLI authentication/read failed; login and a CLI supporting api are required.'); }
      if (result.error || result.status !== 0)
        throw new Error('Vercel CLI authentication/read failed; login and a CLI supporting api are required.');
      try { data = JSON.parse(result.stdout); }
      catch { throw new Error('Vercel CLI returned invalid JSON; deployment blocked.'); }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error)
      throw new Error('Unverified Vercel response; deployment blocked.');
    if (url.pathname === `/v9/projects/${projectId}`) assertRemoteVercelIdentity(data);
    return data;
  };
}
