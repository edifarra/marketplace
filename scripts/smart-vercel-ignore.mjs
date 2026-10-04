// Vercel contract: 0 skips the build, 1 builds. Default to blocking, including import errors.
// This entry point and its dependency graph never execute Git or access the network.
process.exitCode = 0;
try {
  const fs = await import('node:fs');
  const { PLAN_FILE, normalizePlan, verifyPlanMessage, classifyPlan } = await import('./smart-deploy-metadata.mjs');
  const target = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!/^[a-f0-9]{40}$/.test(target ?? '')) throw new Error('Missing/invalid VERCEL_GIT_COMMIT_SHA.');
  const plan = normalizePlan(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')));
  verifyPlanMessage(plan, process.env.VERCEL_GIT_COMMIT_MESSAGE);
  const result = classifyPlan(plan);
  console.log(`Verified committed plan for ${target}, baseline ${plan.base}`);
  console.log(`Smart deployment frontend impact: ${result.frontend}`);
  process.exitCode = result.frontend ? 1 : 0;
} catch (error) {
  console.log(`Cannot verify approved deployment range; build blocked: ${error.message}`);
  process.exitCode = 0;
}
