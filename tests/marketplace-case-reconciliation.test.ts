import test from "node:test";
import assert from "node:assert/strict";
import { loadPage, memoryDatabase } from "./helpers/page-harness";
import { normalizeCase } from "../lib/marketplace-case-domain";
import { processCaseEvent } from "../lib/marketplace-cases";
function harness(options: {failApi?:boolean;failWrite?:boolean;pending?:boolean} = {}) {
  const row: any={id:"11111111-1111-4111-8111-111111111111",marketplace:"shopee",marketplace_account_id:"SP-ED",case_type:"return",external_case_id:"R1",order_id:"O1",status:"PROCESSING"};
  const db: any=memoryDatabase({marketplace_cases:[row],marketplace_case_sync_control:[{last_checked_at:null}],config_marketplace_accounts:[{active:true}]});
  const events: any[]=[];let held=false;
  db.rpc=(name:string,args:any)=>({throwOnError:async()=>{events.push({name,args});if(name==="begin_marketplace_case_refresh"){if(held)return {data:false};held=true;}if(name==="finish_marketplace_case_refresh")held=false;return {data:name==="marketplace_case_has_pending_event"?Boolean(options.pending):true};}});
  const enrich=async(id:string)=>{events.push({name:"remote",id,account:row.marketplace_account_id});if(options.failApi)throw new Error("429");return row.marketplace==="shopee"?{return_sn:id,order_sn:"O1",return_status:row.status}:{id,status:row.status,resource:"order",resource_id:"O1",__case_enrichment:{messages:[],actions:[],statuses:[]}};};
  const module=loadPage("lib/marketplace-case-reconciliation.ts",{
    "node:crypto":{randomUUID:()=>"22222222-2222-4222-8222-222222222222"},"./supabase-admin":{supabaseAdmin:()=>db},
    "./mercado-livre":{getMercadoLivreAccountById:async()=>({active:true})},"./marketplace-case-enrichment":{enrichMercadoLivreClaim:enrich,enrichShopeeReturn:enrich},
    "./marketplace-case-domain":{normalizeCase},"./marketplace-cases":{persistCaseObservation:async(o:any)=>{events.push({name:"persist",o});if(options.failWrite)throw new Error("database unavailable");}},
  });
  return {module,row,db,events,activity:{id:"job",marketplace:"shopee",received_at:"2026-01-01T00:00:00Z",raw_payload:{case_reconcile_id:row.id}}};
}
test("hourly refresh follows the exact account and never processes terminal, unknown or pending-webhook cases",async()=>{
 const h=harness();assert.equal(h.module.CASE_RECONCILIATION_MS,3600000);
 for(const [account,marketplace] of [["SP-ED","shopee"],["SP-GI","shopee"],["ML-ED","mercado_livre"],["ML-GI","mercado_livre"]]){
  Object.assign(h.row,{marketplace,marketplace_account_id:account,case_type:marketplace==="shopee"?"return":"claim",status:marketplace==="shopee"?"PROCESSING":"opened"});
  await h.module.processCaseReconciliation({...h.activity,marketplace},h.db);
 }
 assert.deepEqual(h.events.filter(e=>e.name==="remote").map(e=>e.account),["SP-ED","SP-GI","ML-ED","ML-GI"]);
 for(const [marketplace,status] of [["shopee","CLOSED"],["shopee","CANCELLED"],["mercado_livre","closed"],["shopee","FUTURE"]]){
  Object.assign(h.row,{marketplace,status});await h.module.processCaseReconciliation({...h.activity,marketplace},h.db);
 }
 assert.equal(h.events.filter(e=>e.name==="remote").length,4);
 const pending=harness({pending:true});await pending.module.processCaseReconciliation(pending.activity,pending.db);
 assert.equal(pending.events.some(e=>e.name==="remote"),false);assert.equal(pending.events.at(-1).args.p_success,null);
});
test("temporary API/persistence failures release the lease without falsely recording success; next execution recovers",async()=>{
 for(const options of [{failApi:true},{failWrite:true}]){
  const h=harness(options);await assert.rejects(h.module.processCaseReconciliation(h.activity,h.db));
  assert.equal(h.events.at(-1).args.p_success,false);
  options.failApi=false;options.failWrite=false;
  await h.module.processCaseReconciliation(h.activity,h.db);assert.equal(h.events.at(-1).args.p_success,true);
 }
});
test("webhook and hourly refresh share one lease across the remote read and its persistence",async()=>{
 const h=harness();let finish!:()=>void;let remote=0,persisted=0;
 const wait=new Promise<void>(r=>{finish=r;});
 const deps:any={persist:async()=>{persisted++;return h.row.id;},eligible:async()=>true,enriched:async()=>false,
  history:async()=>{},failure:async()=>{},enrich:async()=>{remote++;await wait;return {return_sn:"R1",return_status:"PROCESSING"};},
  refresh:(id:string,run:()=>Promise<string>)=>h.module.withCaseRefreshLease(id,run,h.db)};
 const event={id:"webhook",marketplace:"shopee",received_at:"2026-10-08T00:00:00Z",raw_payload:{code:29,data:{return_sn:"R1"}}};
 const webhook=processCaseEvent(event,"SP-ED",deps);
 for(let i=0;i<8;i++)await Promise.resolve();
 await assert.rejects(h.module.processCaseReconciliation(h.activity,h.db),/já está sendo atualizado/);
 finish();await webhook;assert.equal(remote,1);assert.equal(persisted,2);assert.equal(h.events.at(-1).args.p_success,true);
});

test("actual safety runner for 100 unchanged cases uses 26 consolidated RPCs, no individual reads, no queue requests",async()=>{
 const h=harness();const rows=Array.from({length:100},(_,i)=>({...h.row,id:`case-${i}`,external_case_id:`R${i}`,account:{active:true}}));
 let cursor=0,remote=0;const calls:string[]=[];
 h.db.from=()=>{throw new Error("Redundant individual read");};
 h.db.rpc=(name:string,args:any)=>({throwOnError:async()=>{
  calls.push(name);
  if(name==="claim_marketplace_case_checks"){const data=rows.slice(cursor,cursor+20);cursor+=data.length;return {data};}
  assert.equal(name,"finish_marketplace_case_checks");assert.ok(args.p_results.length<=5);
  remote+=args.p_results.filter((r:any)=>r.observation).length;return {data:{checked:args.p_results.length,queued:0}};
 }});
 const result=await h.module.scheduleCaseReconciliation(h.db);
 assert.equal(result.checked,100);assert.equal(result.queued,0);assert.equal(remote,100);assert.equal(calls.length,26);
 assert.equal(calls.filter(n=>n==="claim_marketplace_case_checks").length,6);
});

test("ML still reads independent resources when claim timestamp is stable, and gets one token per bundle",async()=>{
 let tokens=0;const calls:string[]=[];
 const {loadMercadoLivreClaimBundle}=loadPage("lib/marketplace-case-enrichment.ts",{
  "./mercado-livre":{getValidMercadoLivreAccessToken:async()=>{tokens++;return "mock";},mlGet:async(path:string)=>{calls.push(path);return path.endsWith("/123")?{id:123,last_updated:"2026-10-08T00:00:00Z",reason_id:"reason"}:{};}},
  "./shopee":{},"./shopee-oauth":{},"./marketplace-claim-domain":{claimBuyerId:()=>null},
 }, (await import("node:fs")).readFileSync("lib/marketplace-case-enrichment.ts","utf8").replace("AbortSignal.timeout(20_000)","undefined"));
 await loadMercadoLivreClaimBundle("123",{});await loadMercadoLivreClaimBundle("123",{});
 assert.equal(tokens,2);assert.equal(calls.length,14);
 for(const path of ["messages","status-history","actions-history","expected-resolutions","affects-reputation"])assert.equal(calls.filter(p=>p.endsWith('/'+path)).length,2);
});

test("captured changes are persisted only by queue and do not repeat remote GET; worker can yield after a batch",async()=>{
 const h=harness();
 // Identity for this fixture comes from the real notification normalizer.
 const actual=normalizeCase({id:"probe",marketplace:"shopee",received_at:new Date().toISOString(),raw_payload:{code:29,data:{return_sn:"R1"}}},"SP-ED",{return_sn:"R1",return_status:"PROCESSING"})!;
 await h.module.processCaseReconciliation({...h.activity,raw_payload:{...h.activity.raw_payload,account_id:"SP-ED",case_observation:actual}},h.db);
 assert.equal(h.events.some(e=>e.name==="remote"),false);assert.equal(h.events.filter(e=>e.name==="persist").length,1);
 let claims=0;
 h.db.rpc=(name:string,args:any)=>({throwOnError:async()=>name==="claim_marketplace_case_checks"?{data:++claims===1?[{...h.row,account:{active:true}}]:[]}:{data:{checked:args.p_results.length,queued:0}}});
 assert.equal((await h.module.scheduleCaseReconciliation(h.db,1)).drained,false);
 assert.equal(claims,1);assert.equal((await h.module.scheduleCaseReconciliation(h.db,1)).drained,true);
});
