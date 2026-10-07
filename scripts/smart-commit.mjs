import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from './smart-git.mjs';
import { readJson, assertDeploymentMetadata } from './smart-deploy-support.mjs';
import { PLAN_FILE, normalizePlan, planDigest, verifyPlanMessage } from './smart-deploy-metadata.mjs';

// Creates a new commit only. Recovery never amends a published commit or pushes.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '-m' || !args[1].trim())
    throw new Error('Usage: npm run commit:smart -- -m "Commit message"');
  if (/Smart-Deploy-(?:Base|Plan)\s*:/i.test(args[1]))
    throw new Error('Trailers are generated automatically; omit them from the message.');
  const state = readJson('.smart-deploy-state.json');
  if (!state || !/^[a-f0-9]{40}$/.test(state.commit))
    throw new Error('A confirmed deployment state with a full baseline SHA is required. Do not fabricate it.');
  const base = state.commit;
  const parent = git(['rev-parse', 'HEAD']);
  execFileSync(process.execPath, [fileURLToPath(new URL('./smart-deploy-prepare.mjs', import.meta.url)), `--base=${base}`], { stdio: 'inherit' });
  const tree = git(['write-tree']);
  const plan = normalizePlan(JSON.parse(git(['show', `:${PLAN_FILE}`])));
  const message = `${args[1].trim()}\n\nSmart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${planDigest(plan)}`;
  verifyPlanMessage(plan, message);
  if (git(['rev-parse', 'HEAD']) !== parent || git(['write-tree']) !== tree)
    throw new Error('HEAD/index changed while preparing commit.');
  git(['commit', '-m', message]);
  assertDeploymentMetadata(process.cwd(), 'HEAD', base);
  console.log(`Created and verified ${git(['rev-parse', 'HEAD'])}. No push or deployment performed.`);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
