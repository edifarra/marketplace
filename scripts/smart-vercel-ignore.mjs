import { git } from './smart-git.mjs';
import { classifyRange, commitBaseline } from './smart-deploy-support.mjs';

// Vercel contract: 0 skips the build, 1 builds. Unknown history blocks publication.
try {
  const root = process.cwd();
  const target = git(['rev-parse', 'HEAD']);
  const base = commitBaseline(root, target);
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') git(['fetch', '--unshallow', '--no-tags', 'origin']);
  try { git(['cat-file', '-e', `${base}^{commit}`]); }
  catch { git(['fetch', '--no-tags', 'origin', base]); }
  git(['merge-base', '--is-ancestor', base, target]);
  const result = classifyRange(root, base, target);
  console.log(`Smart deployment frontend impact: ${result.frontend}`);
  process.exitCode = result.frontend ? 1 : 0;
} catch (error) {
  console.log(`Cannot verify approved deployment range; build blocked: ${error.message}`);
  process.exitCode = 0;
}
