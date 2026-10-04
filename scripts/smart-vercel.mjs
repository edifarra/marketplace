export function assertVercelProject(info) {
  if (info.link?.productionBranch !== 'main') throw new Error('Vercel Git production branch must be main.');
  if (info.autoExposeSystemEnvs !== true) throw new Error('Vercel must explicitly expose system environment variables before pushing this commit.');
}
export function selectDeployment(deployments, target, projectId) {
  return deployments.filter(d => d.projectId === projectId && d.target === 'production' &&
    (d.meta?.githubCommitSha ?? d.meta?.gitlabCommitSha ?? d.meta?.bitbucketCommitSha) === target)
    .sort((a, b) => (b.createdAt ?? b.created) - (a.createdAt ?? a.created))[0];
}
export async function waitForVercel({ target, projectId, request, timeoutMs = 1_200_000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const data = await request(`/v7/deployments?projectId=${encodeURIComponent(projectId)}&target=production&sha=${target}&limit=100`);
    const deployment = selectDeployment(data.deployments ?? [], target, projectId);
    const state = deployment?.readyState ?? deployment?.state;
    if (['ERROR', 'CANCELED', 'BLOCKED'].includes(state)) throw new Error(`Vercel ${state} for ${target}; baseline unchanged.`);
    if (state === 'READY') {
      const detail = await request(`/v13/deployments/${deployment.uid ?? deployment.id}`);
      const detailSha = detail.meta?.githubCommitSha ?? detail.meta?.gitlabCommitSha ?? detail.meta?.bitbucketCommitSha;
      // Identity is proven by the filtered list and the exact deployment ID lookup.
      // Public/reduced detail responses may omit projectId and Git metadata.
      if ((detail.id ?? detail.uid) !== (deployment.uid ?? deployment.id) ||
          (detail.projectId != null && detail.projectId !== projectId) || detail.target !== 'production' ||
          (detailSha != null && detailSha !== target) ||
          detail.readyState !== 'READY' || detail.aliasError)
        throw new Error('Vercel READY did not confirm production alias and exact SHA.');
      if (detail.aliasAssigned === true || Number(detail.aliasAssigned) > 0) return detail.id ?? detail.uid;
    }
    log(`Waiting for Vercel ${target}: ${state ?? 'not found'}`);
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }
  throw new Error('Vercel timeout; baseline unchanged.');
}
