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
export function migrationsConfirmed(output, expected) {
  const rows = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)
    .map(line => line.split(/[|│]/).map(v => v.trim()))
    .filter(columns => columns.length >= 3 && (/^\d+$/.test(columns[0]) || /^\d+$/.test(columns[1])));
  if (!rows.length || !expected.length) throw new Error('Unrecognized/empty migration history; refusing to assume success.');
  if (rows.some(([local, remote]) => remote && !expected.includes(remote))) throw new Error('Remote migration history diverges from the target.');
  return expected.every(version => rows.some(([local, remote]) => local === version && remote === version));
}
