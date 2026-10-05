import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { deploymentMode } from './smart-execution-policy.mjs';
import { spawnCommand, formatSpawnError } from './smart-command-runner.mjs';
import { git, assertDeploymentRepository } from './smart-git.mjs';
import { workerCommand } from './smart-worker-command.mjs';
import { findRelatedTests } from './smart-change-classifier.mjs';
import { executeDeployment } from './smart-deploy-flow.mjs';
import { IGNORE_COMMAND, classifyRange, commitBaseline, assertCommitPlan, atomicJson, readJson, migrationVersions, migrationStatus, migrationsConfirmed } from './smart-deploy-support.mjs';
import { waitForVercel, assertVercelProject } from './smart-vercel.mjs';
import { createVercelReader, assertLinkedVercelProject } from './smart-vercel-auth.mjs';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const mode = deploymentMode({ execute: args.has('--execute'), dryRun: args.has('--dry-run') });
const statePath = path.join(root, '.smart-deploy-state.json');
const progressPath = path.join(root, '.smart-deploy-progress.json');
const lockPath = path.join(root, '.smart-deploy.lock');
let locked = false;
const run = (command, argv, capture = false) => {
  const result = spawnCommand(command, argv, { cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout: 1_200_000 });
  if (result.error) throw new Error(`${command}: ${formatSpawnError(result.error)}`);
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}); remaining steps stopped.`);
  return result.stdout ?? '';
};
try {
  const historyPath = process.argv.find(a => a.startsWith('--migration-history='))?.slice(20);
  if (historyPath !== undefined && (mode !== 'dry-run' || !historyPath))
    throw new Error('A migration history snapshot is supported only in dry-run mode with a nonempty path.');
  // Freeze before resolving or classifying any range.
  const target = git(['rev-parse', 'HEAD^{commit}']);
  const selectedBase = process.argv.find(a => a.startsWith('--base='))?.slice(7) || process.env.SMART_DEPLOY_BASE || readJson(statePath)?.commit || (mode === 'dry-run' ? 'HEAD^' : null);
  if (!selectedBase) throw new Error('No baseline. Use --base=<commit>.');
  const base = git(['rev-parse', `${selectedBase}^{commit}`]);
  git(['merge-base', '--is-ancestor', base, target]);
  const classification = classifyRange(root, base, target);
  console.log(JSON.stringify({ mode, base, target, ...classification }, null, 2));
  if (mode !== 'execute') {
    if (mode === 'dry-run') console.log('DRY RUN: no network connection or production change was made.');
    console.log('Remote status is not verified in planning/dry-run mode.');
    if (historyPath) {
      const status = migrationStatus(fs.readFileSync(historyPath, 'utf8'), migrationVersions(root));
      console.log(JSON.stringify({ migrationHistorySnapshot: historyPath, ...status, pendingCount: status.pending.length }, null, 2));
      console.log('Migration status above comes from the supplied read-only snapshot; execution always queries the linked database again.');
    }
  } else {
    assertDeploymentRepository({ cwd: root, target });
    const active = classification.frontend || classification.migration || classification.worker;
    if (active) {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, target }), { flag: 'wx' });
      locked = true;
    }
    let project;
    let request;
    let linkedProject;
    const assertLinkedProject = () => {
      if (fs.readFileSync('supabase/.temp/project-ref', 'utf8').trim() !== linkedProject) throw new Error('Supabase linked project changed during deployment.');
    };
    const originUrl = active ? git(['remote', 'get-url', '--all', 'origin']) : null;
    const assertOrigin = () => {
      if (!originUrl || originUrl.includes('\n') || git(['remote', 'get-url', '--all', 'origin']) !== originUrl ||
          git(['remote', 'get-url', '--push', '--all', 'origin']) !== originUrl)
        throw new Error('origin fetch/push must use one unchanged repository URL.');
    };
    const assertLocal = () => assertDeploymentRepository({ cwd: root, target });
    const remoteHead = () => git(['rev-parse', 'refs/remotes/origin/main']);
    const refresh = () => {
      assertLocal();
      if (project) assertLinkedVercelProject(readJson(path.join(root, '.vercel/project.json')));
      assertOrigin();
      run('git', ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
      assertDeploymentRepository({ cwd: root, target, remote: true });
      git(['merge-base', '--is-ancestor', base, remoteHead()]);
      // No force, merge or rebase. A normal push remains the final race guard.
    };
    const versions = classification.migration ? migrationVersions(root) : [];
    const supersedeArg = process.argv.find(a => a.startsWith('--supersede-frontend='))?.slice(21);
    const supersedeFrontend = supersedeArg ? git(['rev-parse', `${supersedeArg}^{commit}`]) : null;
    await executeDeployment({ mode, target, base, classification, supersedeFrontend }, {
      preflight: async () => {
        assertLocal();
        if (commitBaseline(root, target) !== base) throw new Error('Commit trailer must match selected baseline.');
        assertCommitPlan(root, target, base, classification);
        if (JSON.parse(fs.readFileSync('vercel.json', 'utf8')).ignoreCommand !== IGNORE_COMMAND) throw new Error('Shared Vercel ignore command required.');
        refresh();
        if (classification.migration) {
          if (git(['diff', '--name-only', '--diff-filter=MDRT', base, target, '--', 'supabase/migrations/'])) throw new Error('Existing migrations cannot be edited, removed or renamed; add a new migration.');
          run('npx', ['--no-install', 'supabase', 'db', 'push', '--help'], true);
          run('npx', ['--no-install', 'supabase', 'migration', 'list', '--help'], true);
          if (!fs.existsSync('supabase/.temp/project-ref')) throw new Error('Supabase linked project required.');
          linkedProject = fs.readFileSync('supabase/.temp/project-ref', 'utf8').trim();
          if (!linkedProject) throw new Error('Empty Supabase linked project.');
          console.log(`Supabase linked project: ${linkedProject}`);
        }
        if (classification.frontend) {
          project = readJson(path.join(root, '.vercel/project.json'));
          assertLinkedVercelProject(project);
          request = createVercelReader({ project, cwd: root });
          console.log(`Vercel project: ${project.projectId}`);
          const info = await request(`/v9/projects/${project.projectId}`);
          assertVercelProject(info);
        }
      },
      validate: async () => {
        const tests = findRelatedTests(root, classification.files);
        if (tests.length) run('npx', ['--no-install', 'tsx', '--test', ...tests]);
        if (classification.typecheck) run('npm', ['run', 'typecheck']);
        if (classification.frontend || classification.build) run('npm', ['run', 'build']);
      },
      confirm: async () => {
        const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
        try { return await prompt.question('Type DEPLOY to execute this exact plan: '); }
        finally { prompt.close(); }
      },
      revalidate: refresh,
      loadProgress: () => readJson(progressPath),
      canSupersede: progress => {
        try {
          git(['merge-base', '--is-ancestor', progress.target, target]);
          const previous = classifyRange(root, progress.base, progress.target);
          return previous.frontend && !previous.migration && !previous.worker;
        }
        catch { return false; }
      },
      saveProgress: progress => atomicJson(progressPath, progress),
      confirmMigrations: () => {
        assertLinkedProject();
        return migrationsConfirmed(run('npx', ['--no-install', 'supabase', 'migration', 'list', '--linked'], true), versions);
      },
      migrate: () => { assertLinkedProject(); run('npx', ['--no-install', 'supabase', 'db', 'push', '--linked']); },
      isPublished: () => remoteHead() === target,
      push: () => run('git', ['push', 'origin', `${target}:refs/heads/main`]),
      verifyPublished: () => {
        const line = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], true).trim();
        if (line.split(/\s+/)[0] !== target) throw new Error('origin/main is not the exact target SHA.');
      },
      waitVercel: () => waitForVercel({ target, projectId: project.projectId, request }),
      updateWorker: () => {
        const output = run('ssh', ['root@76.13.239.70', workerCommand(target, classification.dependencies)], true);
        if (!output.split(/\r?\n/).includes(`SMART_WORKER_SHA=${target}`)) throw new Error('VPS SHA confirmation missing.');
      },
      complete: state => atomicJson(statePath, state),
      clearProgress: () => { if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath); }
    });
    console.log(active ? 'Deployment completed; baseline updated.' : 'Nothing needs production deployment.');
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (locked) fs.unlinkSync(lockPath);
}
