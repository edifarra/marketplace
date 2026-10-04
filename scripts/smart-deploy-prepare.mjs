import { git, dependencyFilesChanged } from './smart-git.mjs';
import { PLAN_FILE, normalizePlan, planDigest } from './smart-deploy-metadata.mjs';
import { readJson, atomicJson } from './smart-deploy-support.mjs';

// Only local index/metadata operations. Never pushes or changes a production baseline.
try {
  const selected = process.argv.find(a => a.startsWith('--base='))?.slice(7) || process.env.SMART_DEPLOY_BASE || readJson('.smart-deploy-state.json')?.commit;
  if (!selected) throw new Error('Select a deployment baseline with --base=<SHA>.');
  const base = git(['rev-parse', `${selected}^{commit}`]);
  git(['merge-base', '--is-ancestor', base, 'HEAD']);
  // All source changes must already be staged. The generated plan is the only exception.
  const unstaged = git(['diff', '--name-only']).split(/\r?\n/).filter(Boolean).filter(f => f !== PLAN_FILE);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).filter(f => f !== PLAN_FILE);
  if (unstaged.length || untracked.length) throw new Error('Stage all source changes before preparing the deployment plan.');
  const indexTree = git(['write-tree']);
  const files = [...new Set([...git(['diff', '--name-only', '--diff-filter=ACMRD', base, indexTree]).split(/\r?\n/).filter(Boolean), PLAN_FILE])].sort();
  const plan = normalizePlan({ schemaVersion: 1, base, files, dependenciesChanged: dependencyFilesChanged({ base, head: indexTree }) });
  atomicJson(PLAN_FILE, plan);
  git(['add', '--', PLAN_FILE]);
  console.log('Prepared and staged local deployment plan. Commit with both trailers:');
  console.log(`Smart-Deploy-Base: ${base}\nSmart-Deploy-Plan: ${planDigest(plan)}`);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
