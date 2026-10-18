import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { git } from './smart-git.mjs';
import { spawnCommand } from './smart-command-runner.mjs';
import { atomicJson } from './smart-deploy-support.mjs';
import { acquireSmartLock, assertControlRoot, syncDirectory } from './smart-coordination.mjs';
import { readLinkedHistory } from './smart-migration-confirmation.mjs';
import { createVercelReader, EXPECTED_VERCEL_PROJECT, assertLinkedVercelProject } from './smart-vercel-auth.mjs';

const fullSha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const proof = (v, message) => { if (!v) throw new Error(message); };
const bytes = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const digest = value => createHash('sha256').update(value ?? '').digest('hex');
const stateName = '.smart-deploy-state.json', progressName = '.smart-deploy-progress.json';
export async function audit(target, io) {
  proof(fullSha(target), 'Full target SHA required.');
  const report = { schemaVersion: 2, target, startedAt: new Date().toISOString(), checks: {} };
  for (const name of ['github', 'vercel', 'migrations', 'worker']) {
    try { const evidence = await io[name](target); proof(evidence && typeof evidence === 'object', 'Missing evidence.'); report.checks[name] = { ok: true, evidence }; }
    catch (error) { report.checks[name] = { ok: false, error: error.message }; }
  }
  report.finishedAt = new Date().toISOString();
  report.ok = Object.values(report.checks).every(c => c.ok);
  return report;
}

// No bootstrap mode: recover the authentic confirmed baseline separately.
export async function confirm({ root, target, expectedBase, authorization, actor, io,
  storage = { atomic: atomicJson, sync: syncDirectory }, coordination = {} }) {
  proof(fullSha(target) && fullSha(expectedBase), 'Full target and expected baseline SHA required.');
  proof(authorization === `RECONCILE ${target}` && actor?.trim(), 'Explicit RECONCILE <full SHA> authorization and actor required.');
  assertControlRoot(root);
  const release = acquireSmartLock(root, { ...coordination, operation: 'reconcile' });
  try {
    const statePath = path.join(root, stateName), progressPath = path.join(root, progressName);
    const previousBytes = bytes(statePath), progressBytes = bytes(progressPath);
    proof(previousBytes !== null, 'Authentic confirmed baseline required; bootstrap is not supported.');
    const previous = JSON.parse(previousBytes);
    proof(fullSha(previous.commit) && typeof previous.deployedAt === 'string' && Number.isFinite(Date.parse(previous.deployedAt)) && /^dpl_[A-Za-z0-9]+$/.test(previous.deployment ?? ''), 'Invalid confirmed baseline.');
    // A completed state is the durable receipt. Retry only cleans the exact archived journal.
    if (previous.commit === target) {
      proof(/^[a-f0-9-]{36}$/.test(previous.reconciliation ?? ''), 'Target already baseline; no second confirmation allowed.');
      const record = JSON.parse(fs.readFileSync(path.join(root, '.smart-deploy-history', previous.reconciliation+'.json'), 'utf8'));
      proof(record.id === previous.reconciliation && record.previous.commit === expectedBase && record.report.ok === true && record.report.target === target, 'Invalid completion receipt.');
      if (progressBytes !== null) {
        proof(digest(progressBytes) === record.progressDigest, 'Progress differs from completed receipt.');
        fs.unlinkSync(progressPath); storage.sync(root);
      }
      return { ...record, alreadyConfirmed: true };
    }
    proof(previous.commit === expectedBase && expectedBase !== target, 'Baseline differs from expected baseline.');
    await io.ancestor(expectedBase, target);
    const progress = progressBytes === null ? null : JSON.parse(progressBytes);
    proof(!progress || (progress.target === target && progress.base === expectedBase), 'Partial deployment belongs to another target/baseline.');
    // Prove directory fsync support before creating any confirmation artifacts.
    storage.sync(root);
    const report = await audit(target, io);
    proof(report.ok, 'Reconciliation blocked: one or more fresh checks failed.');
    // Re-read every source, with Vercel promotion/aliases last, immediately before persistence.
    const finalReport = await audit(target, { ...io, github: io.github, vercel: io.vercel });
    proof(finalReport.ok, 'Final fresh checks failed.');
    const initialWorker = report.checks.worker.evidence;
    const finalWorker = finalReport.checks.worker.evidence;
    proof(initialWorker.bootId === finalWorker.bootId && initialWorker.daemonPid === finalWorker.daemonPid &&
      initialWorker.pm2Pid === finalWorker.pm2Pid && initialWorker.pid === finalWorker.pid &&
      initialWorker.startTicks === finalWorker.startTicks && initialWorker.startedAt === finalWorker.startedAt,
      'Worker process restarted or changed during reconciliation.');
    const finalVercel = await io.vercel(target);
    proof(finalVercel.id === report.checks.vercel.evidence.id && finalVercel.id === finalReport.checks.vercel.evidence.id, 'Production deployment changed.');
    proof(bytes(statePath) === previousBytes && bytes(progressPath) === progressBytes, 'Baseline/progress changed during audit.');
    await io.ancestor(expectedBase, target);
    const history = path.join(root, '.smart-deploy-history');
    fs.mkdirSync(history, { recursive: true, mode: 0o700 }); storage.sync(root);
    const id = randomUUID();
    const record = { id, actor: actor.trim(), authorization, previous, progress, progressDigest: digest(progressBytes), report: finalReport, finalVercel };
    const fd = fs.openSync(path.join(history, id+'.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record, null, 2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    storage.sync(history);
    proof(bytes(statePath) === previousBytes && bytes(progressPath) === progressBytes, 'Baseline/progress changed while saving evidence.');
    storage.atomic(statePath, { commit: target, deployedAt: finalReport.finishedAt, deployment: finalVercel.id, reconciliation: id });
    // Crash here is recoverable from state receipt, without another UUID/deployedAt.
    if (progressBytes !== null) fs.unlinkSync(progressPath);
    storage.sync(root);
    return record;
  } finally { release(); }
}

export function verifyDeployment(detail, current, target, aliases, domains) {
  proof(detail.id === current?.id && detail.projectId === EXPECTED_VERCEL_PROJECT.projectId &&
    detail.meta?.githubCommitSha === target && detail.target === 'production' && detail.readyState === 'READY' &&
    !detail.aliasError && (detail.aliasAssigned === true || (typeof detail.aliasAssigned === 'number' && Number.isFinite(detail.aliasAssigned) && detail.aliasAssigned > 0)),
    'Vercel exact SHA, READY and current production promotion were not proven.');
  proof(Array.isArray(domains) && domains.length > 0 && aliases?.length === domains.length, 'Explicit production domains and fresh aliases required.');
  domains.forEach((domain, i) => proof(aliases[i]?.alias === domain && aliases[i].projectId === EXPECTED_VERCEL_PROJECT.projectId &&
    aliases[i].deploymentId === detail.id && (!aliases[i].deployment || aliases[i].deployment.id === detail.id) && !aliases[i].deletedAt && !aliases[i].redirect,
    'Expected production alias does not route to the exact deployment.'));
  return { id: detail.id, projectId: detail.projectId, sha: target, readyState: detail.readyState, domains, promoted: true };
}

export function verifyWorker(data, target) {
  proof(data.checkoutSha === target && data.clean === true && data.branch === 'main', 'VPS checkout SHA, branch or cleanliness differs.');
  proof(typeof data.bootId === 'string' && /^[0-9a-f-]{36}$/.test(data.bootId), 'Kernel boot identity unavailable.');
  proof(Number.isFinite(data.checkoutUpdatedAt) && data.checkoutUpdatedAt > 0, 'Checkout update time unavailable.');
  proof(data.pm2 && data.pm2.daemonPid > 1 && data.pm2.home === '/root/.pm2', 'Expected root PM2 daemon unavailable.');
  proof(Array.isArray(data.pm2.apps) && data.pm2.apps.length === 1, 'Expected exactly one PM2 worker.');
  const app = data.pm2.apps[0];
  proof(app.name === 'marketplace-worker' && app.id === 0 && app.status === 'online' && app.mode === 'fork_mode' &&
    app.execPath === '/usr/bin/npm' && app.cwd === '/opt/gestao-marketplace' && app.interpreter === 'none' &&
    JSON.stringify(app.args) === JSON.stringify(['run','worker:marketplace']) && Number.isInteger(app.pid) && app.pid > 1,
    'PM2 worker configuration differs.');
  proof(Array.isArray(data.processes) && data.processes.length > 0, 'No live Node worker candidates.');
  const candidates = data.processes;
  const effective = candidates.filter(p =>
    !candidates.some(other =>
      other.pid !== p.pid &&
      Array.isArray(other.ancestry) &&
      other.ancestry.includes(p.pid)
    )
  );
  proof(effective.length === 1, 'Expected exactly one effective Node worker.');
  const p = effective[0];
  proof(Number.isInteger(p.pid) && p.pid > 1 && /^\d+$/.test(p.startTicks) &&
    p.cwd === '/opt/gestao-marketplace' && p.exe === '/usr/bin/node' && p.workerEntry === true,
    'Node process identity/entry/cwd not proven.');
  proof(Array.isArray(p.ancestry) && p.ancestry.length >= 3 && p.ancestry[0] === p.pid &&
    p.ancestry[1] !== p.pid && p.ancestry.includes(app.pid) && p.ancestry.at(-1) === data.pm2.daemonPid &&
    p.ancestry.indexOf(app.pid) < p.ancestry.length - 1,
    'Worker is not a descendant of the expected PM2-managed npm process.');
  proof(Number.isFinite(p.startedAt) && p.startedAt > data.checkoutUpdatedAt &&
    Math.abs(p.startedAt - app.startedAt) < 120_000,
    'Git checkout was not verifiably updated before the worker started.');
  return { sha: target, verified: true, level: 'operational', limitation: 'No loaded-module attestation',
    bootId: data.bootId, daemonPid: data.pm2.daemonPid, pm2Pid: app.pid,
    pid: p.pid, startTicks: p.startTicks, startedAt: p.startedAt, checkoutUpdatedAt: data.checkoutUpdatedAt };
}
// Read-only operational probe. PM2 CLI is invoked only after locating the exact root daemon.
export const workerProbe = String.raw`const fs=require('fs'),cp=require('child_process');
const root='/opt/gestao-marketplace';
const call=(cmd,args,opts={})=>cp.execFileSync(cmd,args,{cwd:root,encoding:'utf8',timeout:12000,maxBuffer:8*1024*1024,...opts}).trim();
const g=args=>call('git',args,{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
const procIds=fs.readdirSync('/proc').filter(s=>/^\d+$/.test(s));
const cmdline=pid=>fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
const stat=pid=>{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');const a=s.slice(s.lastIndexOf(')')+2).split(' ');return {ppid:Number(a[1]),startTicks:a[19]};};
const daemon=procIds.filter(id=>{try{return cmdline(id).join(' ').includes('PM2 v7.0.3: God Daemon (/root/.pm2)');}catch{return false;}});
if(daemon.length!==1)throw Error('Expected exactly one root PM2 daemon');
const daemonPid=Number(daemon[0]);
const pm=JSON.parse(call('pm2',['jlist'],{env:{...process.env,PM2_HOME:'/root/.pm2'}}));
const apps=pm.filter(p=>p.name==='marketplace-worker').map(p=>({name:p.name,id:p.pm_id,pid:p.pid,status:p.pm2_env?.status,mode:p.pm2_env?.exec_mode,execPath:p.pm2_env?.pm_exec_path,cwd:p.pm2_env?.pm_cwd,args:p.pm2_env?.args,interpreter:p.pm2_env?.exec_interpreter,startedAt:p.pm2_env?.pm_uptime}));
if(apps.length!==1)throw Error('Unexpected PM2 worker count');
const btime=Number(fs.readFileSync('/proc/stat','utf8').match(/^btime (\d+)$/m)?.[1]);
const tickRate=Number(call('getconf',['CLK_TCK']));
if(!Number.isFinite(btime)||!Number.isFinite(tickRate)||tickRate<=0)throw Error('Kernel clock unavailable');
const processes=[];
for(const id of procIds){let args;try{args=cmdline(id);}catch(e){if(['ENOENT','ESRCH'].includes(e.code))continue;throw e;}
 if(!args.some(x=>x==='scripts/marketplace-worker.ts'||x===root+'/scripts/marketplace-worker.ts'))continue;
 const proc='/proc/'+id,exe=fs.readlinkSync(proc+'/exe'),cwd=fs.readlinkSync(proc+'/cwd');
 if(exe!=='/usr/bin/node')continue;
 const first=stat(id),ancestry=[Number(id)];let parent=first.ppid;
 for(let depth=0;depth<20&&parent>1;depth++){ancestry.push(parent);if(parent===daemonPid)break;parent=stat(parent).ppid;}
 const second=stat(id);if(second.startTicks!==first.startTicks||second.ppid!==first.ppid)throw Error('Node restarted during probe');
 processes.push({pid:Number(id),startTicks:first.startTicks,cwd,exe,workerEntry:true,ancestry,startedAt:(btime+Number(first.startTicks)/tickRate)*1000});
}
const reflog=g(['reflog','show','--no-abbrev','--date=iso-strict','-n','40','HEAD']);
const entries=reflog.split('\n').map(s=>({sha:s.split(' ')[0],stamp:s.match(/HEAD@\{([^}]+)\}/)?.[1],operation:s.slice(s.indexOf('}:')+2).trim()}));
const head=g(['rev-parse','HEAD']);
const recent=entries[0];
if(!recent||recent.sha!==head||!recent.stamp||!/(pull --ff-only|reset: moving to)/.test(recent.operation))throw Error('Git checkout update cannot be dated');
const checkoutUpdatedAt=Date.parse(recent.stamp);
if(!Number.isFinite(checkoutUpdatedAt))throw Error('Invalid reflog date');
const pm2After=stat(daemonPid);if(!pm2After.startTicks)throw Error('PM2 daemon disappeared');
console.log(JSON.stringify({checkoutSha:head,branch:g(['branch','--show-current']),clean:!g(['status','--porcelain']),checkoutUpdatedAt,
bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pm2:{daemonPid,home:'/root/.pm2',apps},processes}));`;
const toolingFile = f => /^(?:scripts\/smart-[^/]+\.mjs|tests\/smart-[^/]+\.test\.mjs|docs\/smart-reconciliation\.md|\.smart-deploy-plan\.json|\.gitignore)$/.test(f);
export function assertToolingDescendant(localGit, target, head) {
  localGit(['merge-base', '--is-ancestor', target, head]);
  const files = localGit(['diff','--name-only',target,head]).split('\n').filter(Boolean);
  proof(files.every(toolingFile), 'Descendant includes application changes; reconcile its deployed SHA separately.');
  return files;
}
export function readers(root, deploymentId, projectRef, domains, { runCommand = spawnCommand, request: injectedRequest } = {}) {
  const run = (cmd, args) => {
    const r = runCommand(cmd, args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding:'utf8',stdio:[cmd === 'ssh' ? 'inherit' : 'ignore','pipe','pipe'],timeout:60_000,maxBuffer:8*1024*1024 });
    proof(!r.error && r.status === 0, `${cmd} read failed; remote evidence unavailable.`); return r.stdout;
  };
  const localGit = args => git(args, { cwd: root });
  const request = injectedRequest ?? createVercelReader({ project: EXPECTED_VERCEL_PROJECT, cwd: root });
  return {
    ancestor: (base, target) => { localGit(['merge-base','--is-ancestor',base,target]); },
    github: async target => {
      const origin = localGit(['remote','get-url','--all','origin']);
      proof(/^(https:\/\/github\.com\/edifarra\/marketplace(?:\.git)?|git@github\.com:edifarra\/marketplace(?:\.git)?)$/.test(origin), 'Unexpected repository.');
      const line = run('git',['ls-remote','--exit-code',origin,'refs/heads/main']).trim();
      proof(/^[a-f0-9]{40}\s+refs\/heads\/main$/.test(line), 'Invalid GitHub main response.');
      const sha = line.split(/\s+/)[0];
      assertToolingDescendant(localGit,target,sha);
      const toolSha = localGit(['rev-parse','HEAD']); assertToolingDescendant(localGit,target,toolSha);
      return { repository:'edifarra/marketplace', branch:'main', sha, deployedTarget:target, toolSha };
    },
    vercel: async target => {
      proof(/^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? ''), 'Deployment ID required.');
      proof(Array.isArray(domains) && domains.length > 0 && domains.every(d => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) && new Set(domains).size === domains.length, 'Explicit unique production domains required.');
      assertLinkedVercelProject(JSON.parse(fs.readFileSync(path.join(root,'.vercel/project.json'),'utf8')));
      const project = await request(`/v9/projects/${EXPECTED_VERCEL_PROJECT.projectId}`);
      proof(project.targets?.production?.id === deploymentId, 'Deployment is not current production target.');
      const detail = await request(`/v13/deployments/${deploymentId}`);
      const aliases = [];
      for (const d of domains) aliases.push(await request(`/v4/aliases/${d}?projectId=${EXPECTED_VERCEL_PROJECT.projectId}`));
      const current = await request(`/v9/projects/${EXPECTED_VERCEL_PROJECT.projectId}`);
      return verifyDeployment(detail,current.targets?.production,target,aliases,domains);
    },
    migrations: async target => {
      proof(/^[a-z0-9]{20}$/.test(projectRef ?? ''), 'Explicit Supabase project ref required.');
      proof(fullSha(target), 'Full target required.');
      const files = localGit(['ls-tree','-r','--name-only',target,'--','supabase/migrations']).split('\n').filter(f=>f.endsWith('.sql'));
      proof(files.length && files.every(f => /^supabase\/migrations\/\d+_.+\.sql$/.test(f)), 'Invalid target migration set.');
      const local = fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
      proof(JSON.stringify(local) === JSON.stringify(files.map(f=>path.basename(f)).sort()) && !localGit(['diff',target,'--','supabase/migrations']), 'Working migrations differ from deployed target.');
      const versions = files.map(f=>path.basename(f).split('_')[0]);
      const status = readLinkedHistory(versions,{cwd:root,projectRef});
      proof(status.pending.length === 0 && status.remoteCount === versions.length, 'Pending/incomplete migrations.');
      return { ...status, sourceCommit:target, proves:'migration versions only; not SQL content or schema drift' };
    },
    worker: async target => {
      const encoded = Buffer.from(workerProbe, 'utf8').toString('base64');
      const remote = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
      return verifyWorker(JSON.parse(run('ssh', [
        '-o', 'BatchMode=no',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=15',
        'root@76.13.239.70',
        remote
      ])), target);
    }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (const arg of process.argv.slice(2)) {
      const m = /^--(target|deployment|project-ref|production-domains|expected-base|authorization|actor|mode)=(.+)$/.exec(arg);
      proof(m && !Object.hasOwn(options,m[1]), 'Unknown, empty or duplicate argument.'); options[m[1]]=m[2];
    }
    const root=process.cwd(),mode=options.mode??'audit'; proof(['audit','confirm'].includes(mode),'Use audit or confirm.');
    const io=readers(root,options.deployment,options['project-ref'],options['production-domains']?.split(','));
    const result=mode==='audit'?await audit(options.target,io):await confirm({root,target:options.target,expectedBase:options['expected-base'],authorization:options.authorization,actor:options.actor,io});
    console.log(JSON.stringify(result,null,2)); if(mode==='audit'&&!result.ok)process.exitCode=1;
  } catch(e) { console.error(e.message); process.exitCode=1; }
}
