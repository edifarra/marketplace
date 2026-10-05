import fs from 'node:fs';
import path from 'node:path';
import { git, changedFiles, dependencyFilesChanged } from './smart-git.mjs';
import { classifyChanges, buildWorkerFileSet } from './smart-change-classifier.mjs';
import { PLAN_FILE, parseTrailer, normalizePlan, verifyPlanMessage } from './smart-deploy-metadata.mjs';

export const IGNORE_COMMAND = 'node scripts/smart-vercel-ignore.mjs';
export function classifyRange(root, base, target) {
  return classifyChanges(changedFiles({ base, head: target, cwd: root }), {
    workerFiles: buildWorkerFileSet(root),
    dependenciesChanged: dependencyFilesChanged({ base, head: target, cwd: root })
  });
}
export function commitBaseline(root, target) {
  const message = git(['show', '-s', '--format=%B', target], { cwd: root });
  return parseTrailer(message, 'Smart-Deploy-Base', 40);
}
export function assertCommitPlan(root, target, base, classification) {
  const plan = normalizePlan(JSON.parse(git(['show', `${target}:${PLAN_FILE}`], { cwd: root })));
  verifyPlanMessage(plan, git(['show', '-s', '--format=%B', target], { cwd: root }));
  if (plan.base !== base || JSON.stringify(plan.files) !== JSON.stringify(classification.files) ||
      plan.dependenciesChanged !== classification.dependencies)
    throw new Error('Committed plan differs from the actual baseline-to-target diff; prepare it again.');
  return plan;
}
export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function migrationVersions(root) {
  const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql'));
  if (files.some(f => !/^\d+_.+\.sql$/.test(f))) throw new Error('Unrecognized migration filename.');
  const versions = files.map(f => f.split('_')[0]);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration versions.');
  return versions;
}
export function migrationStatus(output, expected) {
  const invalid = () => { throw new Error('Unrecognized/empty migration history; refusing to assume success.'); };
  if (typeof output !== 'string' || !Array.isArray(expected) || !expected.length ||
      expected.some(v => typeof v !== 'string' || !/^\d+$/.test(v)) || new Set(expected).size !== expected.length) invalid();
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '').trim().replace(/^\uFEFF/, '');
  let rows;
  if (/^[{\[]/.test(clean)) {
    let data;
    try { data = JSON.parse(clean); } catch { invalid(); }
    if (!data || Array.isArray(data) || !Array.isArray(data.migrations) || data.error) invalid();
    rows = data.migrations.map(row => {
      if (!row || typeof row !== 'object' || !Object.hasOwn(row, 'local') || !Object.hasOwn(row, 'remote')) invalid();
      return [row.local, row.remote];
    });
  } else {
    rows = clean.split(/\r?\n/).map(line => line.split(/[|│]/).map(v => v.trim()))
      .filter(columns => columns.length >= 3 && (/^\d+$/.test(columns[0]) || /^\d+$/.test(columns[1])))
      .map(columns => columns.slice(0, 2));
  }
  if (!rows.length) invalid();
  const localVersions = new Set(), remoteVersions = new Set();
  for (const [local, remote] of rows) {
    if (typeof local !== 'string' || typeof remote !== 'string' ||
        (local && !/^\d+$/.test(local)) || (remote && !/^\d+$/.test(remote)) || (!local && !remote)) invalid();
    if (remote && !expected.includes(remote)) throw new Error('Remote migration history diverges from the target.');
    if ((local && !expected.includes(local)) || (local && remote && local !== remote))
      throw new Error('Local/remote migration history diverges from the target.');
    if ((local && localVersions.has(local)) || (remote && remoteVersions.has(remote)))
      throw new Error('Duplicate migration versions in CLI history.');
    if (local) localVersions.add(local);
    if (remote) remoteVersions.add(remote);
  }
  // A truncated/inconsistent local history is not permission to push migrations.
  if (expected.some(v => !localVersions.has(v))) throw new Error('Local migration history is incomplete for the target.');
  const applied = expected.filter(v => rows.some(([local, remote]) => local === v && remote === v));
  return { localCount: localVersions.size, remoteCount: remoteVersions.size,
    applied, pending: expected.filter(v => !applied.includes(v)) };
}
export function migrationsConfirmed(output, expected) {
  return migrationStatus(output, expected).pending.length === 0;
}
