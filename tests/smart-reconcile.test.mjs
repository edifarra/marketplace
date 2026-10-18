import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, migrationStatus } from '../scripts/smart-deploy-support.mjs';
import { audit, confirm, verifyWorker, workerProbe, verifyDeployment, assertToolingDescendant } from '../scripts/smart-reconcile.mjs';
import { acquireSmartLock, assertControlRoot } from '../scripts/smart-coordination.mjs';
import { EXPECTED_VERCEL_PROJECT as project } from '../scripts/smart-vercel-auth.mjs';
const target='f6414359a3d91327d36fa88c0a4296ff7cf5eb9f',base='a237912b7e610f8cf3ba891a051706d83c32edf5';
const initial={commit:base,deployedAt:'2026-10-09T05:05:30.929Z',deployment:'dpl_old'};
const good=()=>({...Object.fromEntries(['github','vercel','migrations','worker'].map(k=>[k,async()=>({id:'dpl_test',sha:target})])),ancestor:async()=>{}});
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reconcile-'));
 const before=process.env.SMART_DEPLOY_CONTROL_ROOT;process.env.SMART_DEPLOY_CONTROL_ROOT=root;
 t.after(()=>{if(before===undefined)delete process.env.SMART_DEPLOY_CONTROL_ROOT;else process.env.SMART_DEPLOY_CONTROL_ROOT=before;fs.rmSync(root,{recursive:true,force:true});});
 const state=path.join(root,'.smart-deploy-state.json'),progress=path.join(root,'.smart-deploy-progress.json');
 fs.writeFileSync(state,JSON.stringify(initial));
 return {root,state,progress,args:{root,target,expectedBase:base,io:good(),actor:'operator',authorization:`RECONCILE ${target}`,storage:{atomic:atomicJson,sync:()=>{}},coordination:{lockPath:path.join(root,'global.lock')}}};
}
for(const name of ['github','vercel','migrations','worker'])test(`${name} fresh failure preserves baseline and progress`,async t=>{
 const f=fixture(t),old=fs.readFileSync(f.state,'utf8');f.args.io[name]=async()=>{throw Error('unavailable');};
 assert.equal((await audit(target,f.args.io)).ok,false);await assert.rejects(confirm(f.args),/checks failed/);assert.equal(fs.readFileSync(f.state,'utf8'),old);
 assert.equal(fs.existsSync(path.join(f.root,'global.lock')),false);
});
test('missing baseline cannot bootstrap even with valid evidence',async t=>{const f=fixture(t);fs.unlinkSync(f.state);await assert.rejects(confirm(f.args),/bootstrap/);assert.equal(fs.existsSync(f.state),false);});
for(const invalid of [{},{commit:'old'},{...initial,deployedAt:'bad'},{...initial,deployment:null}])test('invalid baseline fails closed '+JSON.stringify(invalid),async t=>{const f=fixture(t);fs.writeFileSync(f.state,JSON.stringify(invalid));await assert.rejects(confirm(f.args),/Invalid/);});
test('expected baseline and authorization are mandatory',async t=>{const f=fixture(t);await assert.rejects(confirm({...f.args,authorization:'DEPLOY'}),/authorization/);await assert.rejects(confirm({...f.args,expectedBase:'b'.repeat(40)}),/differs/);});
test('regression/nonancestor blocked before audit',async t=>{const f=fixture(t);f.args.io.ancestor=()=>{throw Error('not ancestor');};await assert.rejects(confirm(f.args),/ancestor/);});
test('duplicate confirmation preserves UUID, timestamp, history and has no fresh side effects',async t=>{
 const f=fixture(t);fs.writeFileSync(f.progress,JSON.stringify({target,base,pushed:true,migration:true}));
 const first=await confirm(f.args),state=fs.readFileSync(f.state,'utf8');assert.equal(fs.existsSync(f.progress),false);
 f.args.io.github=()=>{throw Error('must not run');};const second=await confirm(f.args);
 assert.equal(second.id,first.id);assert.equal(second.alreadyConfirmed,true);assert.equal(fs.readFileSync(f.state,'utf8'),state);
 assert.equal(fs.readdirSync(path.join(f.root,'.smart-deploy-history')).length,1);
});
test('crash after state replacement recovers archived progress without new confirmation',async t=>{
 const f=fixture(t);const journal=JSON.stringify({target,base});fs.writeFileSync(f.progress,journal);await confirm(f.args);fs.writeFileSync(f.progress,journal);
 const old=fs.readFileSync(f.state,'utf8');await confirm(f.args);assert.equal(fs.existsSync(f.progress),false);assert.equal(fs.readFileSync(f.state,'utf8'),old);
 fs.writeFileSync(f.progress,'{"target":"other"}');await assert.rejects(confirm(f.args),/differs/);
});
for(const name of ['state','progress'])test('concurrent '+name+' mutation blocks persistence',async t=>{
 const f=fixture(t);const file=f[name];f.args.io.worker=async()=>{fs.writeFileSync(file,'{"changed":true}');return {};};
 await assert.rejects(confirm(f.args),/changed during audit/);assert.equal(fs.existsSync(path.join(f.root,'.smart-deploy-history')),false);
});
for(const journal of [{target:'other',base},{target,base:'b'.repeat(40)},{target}])test('foreign/incomplete progress rejected '+JSON.stringify(journal),async t=>{const f=fixture(t);fs.writeFileSync(f.progress,JSON.stringify(journal));await assert.rejects(confirm(f.args),/another target/);});
test('final audit and last Vercel promotion are rechecked',async t=>{const f=fixture(t);let n=0;f.args.io.vercel=async()=>({id:++n===3?'dpl_changed':'dpl_test'});await assert.rejects(confirm(f.args),/deployment changed/);assert.equal(JSON.parse(fs.readFileSync(f.state)).commit,base);});
test('atomic replacement failure leaves baseline and progress intact',async t=>{const f=fixture(t);const old=fs.readFileSync(f.state,'utf8');fs.writeFileSync(f.progress,JSON.stringify({target,base}));f.args.storage.atomic=()=>{throw Error('disk failed');};await assert.rejects(confirm(f.args),/disk failed/);assert.equal(fs.readFileSync(f.state,'utf8'),old);assert.equal(fs.existsSync(f.progress),true);});
test('unsupported directory durability blocks before evidence/state write',async t=>{const f=fixture(t);f.args.storage.sync=()=>{throw Error('fsync unsupported');};await assert.rejects(confirm(f.args),/fsync unsupported/);assert.equal(fs.existsSync(path.join(f.root,'.smart-deploy-history')),false);});
test('history write failure preserves baseline',async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'.smart-deploy-history'),'blocked');await assert.rejects(confirm(f.args));assert.equal(JSON.parse(fs.readFileSync(f.state)).commit,base);});
test('host lock excludes copies and records ownership; never steals stale locks',t=>{const f=fixture(t),lockPath=path.join(f.root,'host.lock');const release=acquireSmartLock(f.root,{lockPath});const owner=JSON.parse(fs.readFileSync(lockPath));assert.equal(owner.pid,process.pid);assert.ok(owner.startedAt);assert.throws(()=>acquireSmartLock(os.tmpdir(),{lockPath}),/EEXIST/);release();fs.writeFileSync(lockPath,'{"pid":99999999}');assert.throws(()=>acquireSmartLock(f.root,{lockPath}),/EEXIST/);});
test('foreign lock replacement is never removed',t=>{const f=fixture(t),lockPath=path.join(f.root,'host.lock');const release=acquireSmartLock(f.root,{lockPath});fs.writeFileSync(lockPath,'{"id":"replacement"}');assert.throws(release,/ownership/);assert.equal(fs.existsSync(lockPath),true);});
test('legacy lock and noncanonical state workspace block',t=>{const f=fixture(t);assert.throws(()=>assertControlRoot(os.tmpdir()),/canonical/);fs.writeFileSync(path.join(f.root,'.smart-deploy.lock'),'old');assert.throws(()=>acquireSmartLock(f.root,f.args.coordination),/Legacy lock/);});
test('tooling descendant independent of deployed target; application descendants rejected',()=>{const run=args=>args[0]==='diff'?'scripts/smart-reconcile.mjs\ndocs/smart-reconciliation.md':'';assert.equal(assertToolingDescendant(run,target,'b'.repeat(40)).length,2);assert.throws(()=>assertToolingDescendant(args=>args[0]==='diff'?'app/page.tsx':'',target,'b'.repeat(40)),/application/);assert.throws(()=>assertToolingDescendant(()=>{throw Error('not ancestor');},target,base),/ancestor/);});
test('worker evidence rejects incomplete PM2 metadata',()=>{assert.throws(()=>verifyWorker({checkoutSha:target,clean:true,branch:'main'},target));assert.match(workerProbe,/PM2/);});
test('Vercel strict alias assignment, domain, project and current promotion',()=>{
 const d={id:'dpl_test',projectId:project.projectId,meta:{githubCommitSha:target},target:'production',readyState:'READY',aliasAssigned:true};
 const aliases=[{alias:'app.example.com',projectId:project.projectId,deploymentId:d.id}];const check=(detail=d,current=d,a=aliases)=>verifyDeployment(detail,current,target,a,['app.example.com']);assert.equal(check().promoted,true);
 for(const v of ['true','1',false,NaN,Infinity,0,-1])assert.throws(()=>check({...d,aliasAssigned:v}));
 for(const delta of [{alias:'other.example.com'},{deploymentId:'dpl_other'},{projectId:'wrong'},{redirect:'elsewhere'},{deletedAt:123}])assert.throws(()=>check(d,d,[{...aliases[0],...delta}]));
 assert.throws(()=>check(d,{id:'dpl_other'}));assert.throws(()=>check({...d,meta:{}}));assert.throws(()=>verifyDeployment(d,d,target,[],[]));
});
test('malformed table suffix, duplicates, remote extras, truncated and mismatched migrations fail closed',()=>{
 for(const text of ['001 | 001 | date\nERROR truncated','001 | 001 | date\nBAD | BAD | date','001 | 001 | date\n001 | 001 | date','001 | 001 | date\n | 999 | date','001 | 002 | date','Local | Remote | Time\n---+---+---'])assert.throws(()=>migrationStatus(text,['001']));
 assert.throws(()=>migrationStatus('001 | 001 | date',['001','002']),/incomplete/);
});
import vm from 'node:vm';
test('worker probe uses PM2 daemon detection and Git reflog',()=>{assert.match(workerProbe,/reflog/);assert.match(workerProbe,/jlist/);assert.match(workerProbe,/startTicks/);});
import { createVercelReader } from '../scripts/smart-vercel-auth.mjs';
import { readers } from '../scripts/smart-reconcile.mjs';
test('alias API reader pins project/team and rejects an arbitrary alias scope',async()=>{
 const request=createVercelReader({project,token:'fixture',fetchImpl:async(url,options)=>{
  assert.equal(url.pathname,'/v4/aliases/app.example.com');assert.equal(url.searchParams.get('teamId'),project.orgId);assert.equal(url.searchParams.get('projectId'),project.projectId);assert.equal(options.method,'GET');return {ok:true,json:async()=>({alias:'app.example.com'})};
 }});
 await request('/v4/aliases/app.example.com?projectId='+project.projectId);
 await assert.rejects(request('/v4/aliases/app.example.com?projectId=wrong'),/Unsupported/);
});
test('Vercel reader reconsults promotion after reading the production domain',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'.vercel'));fs.writeFileSync(path.join(f.root,'.vercel/project.json'),JSON.stringify(project));
 const endpoints=[];let projectReads=0;
 const io=readers(f.root,'dpl_test','abcdefghijklmnopqrst',['app.example.com'],{request:async endpoint=>{
  endpoints.push(endpoint);
  if(endpoint.startsWith('/v9'))return {targets:{production:{id:++projectReads===1?'dpl_test':'dpl_changed'}}};
  if(endpoint.startsWith('/v13'))return {id:'dpl_test',projectId:project.projectId,meta:{githubCommitSha:target},target:'production',readyState:'READY',aliasAssigned:true};
  return {alias:'app.example.com',projectId:project.projectId,deploymentId:'dpl_test'};
 }});
 await assert.rejects(io.vercel(target),/promotion/);assert.equal(projectReads,2);assert.equal(endpoints.length,4);
});


test('operational PM2 proof accepts the known process chain and rejects stale/mismatched states',()=>{
 const now=Date.now();
 const data={checkoutSha:target,clean:true,branch:'main',checkoutUpdatedAt:now-3600000,
  bootId:'14001a5f-a106-4083-b496-7904f4f7962d',
  pm2:{daemonPid:795,home:'/root/.pm2',apps:[{name:'marketplace-worker',id:0,pid:826,status:'online',mode:'fork_mode',execPath:'/usr/bin/npm',cwd:'/opt/gestao-marketplace',args:['run','worker:marketplace'],interpreter:'none',startedAt:now-1000000}]},
  processes:[{pid:881,ppid:866,startTicks:'899',cwd:'/opt/gestao-marketplace',exe:'/usr/bin/node',workerEntry:true,startedAt:now-1000000,ancestry:[881,866,865,826,795]}]};
 assert.equal(verifyWorker(data,target).level,'operational');
 assert.throws(()=>verifyWorker({...data,checkoutUpdatedAt:now},target),/before the worker/);
 assert.throws(()=>verifyWorker({...data,pm2:{...data.pm2,apps:[]}},target),/exactly one PM2 worker/);
 assert.throws(()=>verifyWorker({...data,processes:[{...data.processes[0],ancestry:[881,866,777,795]}]},target),/not a descendant/);
 assert.throws(()=>verifyWorker({...data,processes:[{...data.processes[0],startTicks:'bad'}]},target),/identity/);
 assert.throws(()=>verifyWorker({...data,processes:[...data.processes,...data.processes]},target),/exactly one effective/);
});
