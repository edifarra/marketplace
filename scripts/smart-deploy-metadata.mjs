import { createHash } from 'node:crypto';
import { classifyChanges, normalizeFile } from './smart-change-classifier.mjs';

export const PLAN_FILE = '.smart-deploy-plan.json';
export function parseTrailer(message, name, length) {
  const lines = message.split(/\r?\n/).filter(line => line.startsWith(`${name}:`));
  const match = lines.length === 1 && lines[0].match(new RegExp(`^${name}:[ \\t]*([a-f0-9]{${length}})[ \\t]*$`));
  if (!match) throw new Error(`Commit needs exactly one valid ${name} trailer.`);
  return match[1];
}
export function normalizePlan(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'base,dependenciesChanged,files,schemaVersion' ||
      value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.base) ||
      typeof value.dependenciesChanged !== 'boolean' || !Array.isArray(value.files) ||
      value.files.some(f => typeof f !== 'string' || !f || f !== normalizeFile(f) ||
        f.startsWith('/') || f.split('/').includes('..') || /[\r\n\0]/.test(f)))
    throw new Error('Invalid deployment plan schema.');
  const files = [...new Set(value.files)].sort();
  if (JSON.stringify(value.files) !== JSON.stringify(files) || !files.includes(PLAN_FILE))
    throw new Error('Deployment plan files must be sorted, unique and include the plan itself.');
  return { schemaVersion: 1, base: value.base, files, dependenciesChanged: value.dependenciesChanged };
}
export function planDigest(value) {
  return createHash('sha256').update(JSON.stringify(normalizePlan(value))).digest('hex');
}
export function classifyPlan(value, workerFiles = new Set()) {
  const plan = normalizePlan(value);
  return classifyChanges(plan.files, { workerFiles, dependenciesChanged: plan.dependenciesChanged });
}
export function verifyPlanMessage(plan, message) {
  if (typeof message !== 'string' || !message || Buffer.byteLength(message, 'utf8') >= 2048)
    throw new Error('Missing/truncated commit message; Vercel limits it to 2048 bytes.');
  if (parseTrailer(message, 'Smart-Deploy-Base', 40) !== plan.base ||
      parseTrailer(message, 'Smart-Deploy-Plan', 64) !== planDigest(plan))
    throw new Error('Commit metadata does not match deployment plan.');
}
