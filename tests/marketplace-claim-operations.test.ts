import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ClaimError,ClaimRow,claimEndpoint,claimPayload,validateClaimAction,validatePartialOffer,validPartialOffers } from "../lib/marketplace-claim-domain";
import { executeClaimOperation,operationBaseline,claimOutcomeConfirmed,ClaimOperationDependencies,ClaimRemoteError } from "../lib/marketplace-claim-operations";
import { loadMercadoLivreClaimBundle } from "../lib/marketplace-case-enrichment";
import { claimOfficialEvents,officialClaimMessages,orderedClaimTimeline,saleOfficialEvents } from "../lib/marketplace-claim-timeline";
import { normalizeCase } from "../lib/marketplace-case-domain";
import { safeClaimConversation } from "../lib/marketplace-case-detail";
import { caseDate,caseReason,reputationLabel,sellerDeadline } from "../app/central-reclamacoes/case-display";

const buyer={id:"buyer",currency:"BRL",order_amount:100,paid_amount:110,products:[{title:"Produto",quantity:1,amount:100}]};
test("operator authorization is required before sending but never blocks confirmation of an existing send",async()=>{
  const f=fixture();f.deps.authorize=async()=>{throw new ClaimError("Operador inativo",403);};
  await assert.rejects(executeClaimOperation(f.deps));assert.equal(f.op.remote_execution_state,"rejected");
  const sent=fixture();await executeClaimOperation(sent.deps);
  sent.op.remote_execution_state="succeeded";
  sent.deps.authorize=async()=>{throw new ClaimError("Operador inativo",403);};
  assert.equal((await executeClaimOperation(sent.deps)).confirmed,true);
});
function bundle():ClaimRow{return {id:123,resource:"order",resource_id:456,status:"opened",last_updated:"revision",date_created:"2026-10-06T14:00:00-04:00",
  players:[{role:"complainant",type:"buyer",user_id:"buyer"},{role:"respondent",type:"seller",user_id:"seller",available_actions:["refund","allow_partial_refund","allow_return","send_message_to_complainant"].map(action=>({action,mandatory:action.startsWith("send"),due_date:null}))}],
  __case_enrichment:{buyer,messages:[],actions:[],statuses:[],resolutions:[],return:null}};}
function fixture(action="refund"){
  let remote=bundle(),posts=0,persisted=0,failAck=false,failPersist=false,timeout=false,offersCalls=0;
  const op:any={id:"op",remote_execution_state:"not_started",requested_data:{action,parameters:action === "allow_partial_refund" ? {offer:{percentage:40,amount:40,currency:"BRL"}} : action.startsWith("send") ? {message:"Mensagem pessoal"} : {},
    context:{claimId:"123",orderId:"456",buyerId:"buyer",sellerId:"seller",revision:"revision",currency:"BRL",orderAmount:100,paidAmount:110,products:buyer.products}}};
  const audit:ClaimRow[]=[];
  const deps:ClaimOperationDependencies={load:async()=>structuredClone(op),read:async()=>structuredClone(remote),
    offers:async()=>{offersCalls++;return {currency_id:"BRL",available_offers:[{percentage:40,amount:40}]};},
    baseline:async b=>{op.requested_data.baseline=b;},begin:async()=>{if(op.remote_execution_state!=="not_started")return false;op.remote_execution_state="sending";return true;},
    send:async(endpoint,payload)=>{
      posts++;assert.equal(endpoint,claimEndpoint("123",action as any));
      if(action === "refund"){remote.status="closed";remote.resolution={reason:"payment_refunded"};}
      else if(action === "allow_partial_refund")remote.__case_enrichment.resolutions.push({player_role:"respondent",expected_resolution:"partial_refund",status:"pending",details:[{key:"percentage",value:String(payload?.percentage)}]});
      else if(action === "allow_return")remote.__case_enrichment.return={id:"R1"};
      else remote.__case_enrichment.messages.push({hash:"official-hash",sender_role:"respondent",receiver_role:"complainant",message:payload?.message,status:"available",message_date:"2026-10-07T12:00:00Z"});
      if(timeout)throw new Error("timeout after accepted POST");return {accepted:true};
    },acknowledge:async()=>{if(failAck)throw new Error("DB unavailable after POST");op.remote_execution_state="succeeded";},
    reject:async(_message,afterSend)=>{if(op.remote_execution_state === (afterSend ? "sending" : "not_started"))op.remote_execution_state="rejected";},
    uncertain:async()=>{if(op.remote_execution_state === "sending")op.remote_execution_state="uncertain";},persist:async()=>{persisted++;if(failPersist)throw new Error("local persistence failed");},
    complete:async()=>{op.remote_execution_state="confirmed";},audit:async(stage,details)=>{audit.push({stage,...details});}};
  return {op,deps,audit,remote:()=>remote,posts:()=>posts,persisted:()=>persisted,offersCalls:()=>offersCalls,setTimeout:()=>{timeout=true;},setAckFail:(v:boolean)=>{failAck=v;},setPersistFail:(v:boolean)=>{failPersist=v;},setRemote:(v:ClaimRow)=>{remote=v;}};
}
for(const action of ["refund","allow_partial_refund","allow_return","send_message_to_complainant"]){
  test(`${action}: official endpoint, confirmed result and double-click/retry never repeats POST`,async()=>{const f=fixture(action);await executeClaimOperation(f.deps);await executeClaimOperation(f.deps);assert.equal(f.posts(),1);assert.equal(f.op.remote_execution_state,"confirmed");assert.ok(f.audit.some(a=>a.stage === "revalidated"));assert.ok(f.audit.some(a=>a.stage === "confirmed"));});
}
test("concurrent executors share the durable send barrier",async()=>{const f=fixture();await Promise.allSettled([executeClaimOperation(f.deps),executeClaimOperation(f.deps)]);assert.equal(f.posts(),1);});
test("timeout after remote effect is uncertain, then reconciled without POST",async()=>{const f=fixture();f.setTimeout();await assert.rejects(executeClaimOperation(f.deps),e=>e instanceof ClaimError && e.uncertain);assert.equal(f.op.remote_execution_state,"uncertain");await executeClaimOperation(f.deps);assert.equal(f.posts(),1);});
test("unknown outcome without remote evidence never replays and never claims completion",async()=>{const f=fixture();f.deps.send=async()=>{throw new Error("connection lost");};await assert.rejects(executeClaimOperation(f.deps));await assert.rejects(executeClaimOperation(f.deps));assert.equal(f.op.remote_execution_state,"uncertain");});
for(const phase of ["acknowledgement","persistence"]){test(`local ${phase} failure after POST only retries confirmation`,async()=>{const f=fixture();if(phase === "acknowledgement")f.setAckFail(true);else f.setPersistFail(true);await assert.rejects(executeClaimOperation(f.deps));f.setAckFail(false);f.setPersistFail(false);await executeClaimOperation(f.deps);assert.equal(f.posts(),1);});}
test("worker revalidates withdrawn capability and closure between modal and execution",async()=>{for(const closed of [false,true]){const f=fixture();const b=bundle();if(closed)b.status="closed";else b.players[1].available_actions=[];f.setRemote(b);await assert.rejects(executeClaimOperation(f.deps),ClaimError);assert.equal(f.posts(),0);assert.equal(f.op.remote_execution_state,"rejected");}});
test("changed revision, product or amount invalidates confirmed context",async()=>{for(const key of ["revision","amount","product"]){const f=fixture();const b=bundle();if(key === "revision")b.last_updated="changed";else b.__case_enrichment.buyer={...buyer,...(key === "amount" ? {paid_amount:120} : {products:[]})};f.setRemote(b);await assert.rejects(executeClaimOperation(f.deps));assert.equal(f.posts(),0);}});
test("partial offer requires explicit exact amount, percentage, currency and current restrictions",()=>{
  const p={currency_id:"BRL",available_offers:[{amount:100,percentage:100},{amount:20,percentage:20},{amount:40,percentage:40}],restrictions:[{type:"minimum",percentage:30}]};
  assert.deepEqual(validPartialOffers(p),[{amount:40,percentage:40}]);
  for(const selection of [undefined,{}, {percentage:40,amount:45,currency:"BRL"},{percentage:40,amount:40,currency:"USD"},{percentage:100,amount:100,currency:"BRL"}])assert.throws(()=>validatePartialOffer(p,selection as any),ClaimError);
});
test("worker detects offer removed/changed after modal without posting",async()=>{const f=fixture("allow_partial_refund");f.deps.offers=async()=>({currency_id:"BRL",available_offers:[{percentage:40,amount:45}]});await assert.rejects(executeClaimOperation(f.deps));assert.equal(f.posts(),0);});
test("open_dispute and prototype names are excluded, message never uses packs or attachments",()=>{
  for(const action of ["open_dispute","constructor","toString"])assert.throws(()=>validateClaimAction(bundle(),{claimId:"123",orderId:"456",buyerId:"buyer",sellerId:"seller"},action));
  assert.equal(claimEndpoint("123","send_message_to_complainant"),"/post-purchase/v1/claims/123/actions/send-message");
  assert.deepEqual(claimPayload("send_message_to_complainant",{message:"  texto  ",attachments:["fake"]}),{receiver_role:"complainant",message:"texto"});
});
test("deadline expiry is revalidated",()=>{const b=bundle();b.players[1].available_actions[0].due_date="2020-01-01T00:00:00Z";assert.throws(()=>validateClaimAction(b,{claimId:"123",orderId:"456",buyerId:"buyer",sellerId:"seller"},"refund"));});
test("HTTP auth/action rejection is terminal instead of generic automatic retry",async()=>{const f=fixture();f.deps.send=async()=>{throw new ClaimRemoteError(403);};await assert.rejects(executeClaimOperation(f.deps));assert.equal(f.op.remote_execution_state,"rejected");});
test("old expected return cannot prove a real return or a newly executed operation",()=>{const f=fixture("allow_return");const b=bundle();b.__case_enrichment.resolutions=[{expected_resolution:"return_product",status:"pending"}];f.op.requested_data.baseline=operationBaseline(b);assert.equal(claimOutcomeConfirmed(f.op,b),false);});
test("equivalent historical records with reordered JSON properties are not new evidence",()=>{const f=fixture("allow_return");const b=bundle();b.__case_enrichment.actions=[{action_name:"allow_return",player_role:"respondent",date_created:"2026-10-01"}];f.op.requested_data.baseline=operationBaseline(b);b.__case_enrichment.actions=[{date_created:"2026-10-01",player_role:"respondent",action_name:"allow_return"}];assert.equal(claimOutcomeConfirmed(f.op,b),false);});
test("claim chat identity rejects another account/claim and never selects post-sale",()=>{
  const c={id:"chat",marketplace:"mercado_livre",marketplace_account_id:"a",conversation_type:"claim",external_conversation_id:"claim:123"};
  assert.equal(safeClaimConversation([c],"a","123")?.id,"chat");assert.equal(safeClaimConversation([c],"b","123"),null);assert.equal(safeClaimConversation([c],"a","124"),null);assert.equal(safeClaimConversation([{...c,conversation_type:"post_sale"}],"a","123"),null);
});
test("message hash is stable across webhook/GET/reconciliation and preserves attachments metadata",()=>{
  const m={hash:"official",sender_role:"complainant",message_date:"2026-10-07T12:00:00Z",message:"standby e LEDs",attachments:[{filename:"x.jpg",type:"image/jpeg",size:20}]};
  assert.deepEqual(officialClaimMessages([m],"123"),officialClaimMessages([{...m}],"123"));assert.equal(officialClaimMessages([m],"123")[0].raw.attachments.length,1);
});
test("timeline uses official chronology, stable ties, deduplication and sale opening",()=>{
  const events=claimOfficialEvents({...bundle(),date_created:"2026-10-07T12:00:00Z"},{messages:[],actions:[{action_name:"open_claim",player_role:"complainant",date_created:"2026-10-07T12:00:00Z"}],statuses:[{status:"opened",date:"2026-10-07T12:00:00Z"}],resolutions:[]});
  const sale=saleOfficialEvents({order_id:"456",raw_data:{payload:{order:{id:456,date_created:"2026-10-01T00:00:00Z",payments:[{id:1,date_approved:"2026-10-01T00:00:01Z"}]},shipmentHistory:[{status:"delivered",date:"2026-10-02T00:00:00Z"}]}}});
  const ordered=orderedClaimTimeline([...events,...sale,...events,{id:"fake",observed_at:"2026-10-01T00:00:00Z"}]);assert.equal(ordered.length,4);assert.equal(ordered[0].event_type,"Venda #456");assert.equal(ordered.at(-1)?.event_type,"Reclamação aberta");
  assert.deepEqual(orderedClaimTimeline([...ordered].reverse()),ordered);
});
test("official timezone, not_applies and human reason rendering",()=>{
  assert.equal(caseDate("2026-10-08T22:37:00.000-04:00"),"08/10/2026, 23:37:00");assert.equal(reputationLabel({marketplace:"mercado_livre",reputation_impact:"not_applies"}),"Não se aplica à reputação");
  assert.equal(caseReason({reason_name:"repentant_buyer",reason_code:"PDD9939"}),"O comprador se arrependeu");
  assert.equal(sellerDeadline({status:"closed"},[{responsible:"seller",precision:"timestamp",value:"2026-10-08",purpose:"action:refund"}]),null);
});
test("read-only enrichment never queries offers or Returns based on mere expected_resolution; fiscal differs from logistics",async()=>{
  const calls:string[]=[];const detail:Record<string,any>={...bundle(),reason_id:"PDD",site_id:"MLB",related_entities:[]};delete detail.__case_enrichment;
  const get=async(path:string):Promise<any>=>{calls.push(path);if(path.endsWith("/claims/123"))return detail;
    if(path === "/orders/456")return {id:456,seller:{id:"seller"},buyer:{id:"buyer",first_name:"Nome",billing_info:{id:"fiscal"}},currency_id:"BRL",total_amount:100,paid_amount:110,order_items:[]};
    if(path.includes("billing-info"))return {buyer:{cust_id:"buyer",billing_info:{name:"Empresa Fiscal",identification:{type:"CNPJ",number:"123"},address:{street_name:"Rua Fiscal"}}},seller:{cust_id:"seller"}};
    if(path.endsWith("/expected-resolutions"))return [{expected_resolution:"return_product",status:"pending"}];
    if(path.endsWith("/affects-reputation"))return {affects_reputation:"not_applies"};
    if(path.includes("/reasons/"))return {name:"repentant_buyer",detail:"Descrição oficial"};return [];};
  const enriched=await loadMercadoLivreClaimBundle("123",{seller_id:"seller"} as any,get);
  assert.ok(!calls.some(p=>p.includes("available-offers") || p.endsWith("/returns")));
  assert.equal(enriched.__case_enrichment.buyer?.legal_name,"Empresa Fiscal");assert.equal(enriched.__case_enrichment.return,null);
  const observation=normalizeCase({id:"e",marketplace:"mercado_livre",received_at:"2026-10-07T12:00:00Z",raw_payload:{topic:"post_purchase",claim_id:"123"}},"a",enriched)!;
  assert.equal(observation.snapshot.reverse_logistics.contact_name,null);assert.equal(observation.snapshot.reputation_impact,"not_applies");assert.equal(observation.snapshot.reason,"Descrição oficial");
});
test("offer reads occur only in explicit preparation/validation; listing/detail/reconciliation have no offer request",()=>{
  const ui=readFileSync(new URL("../app/central-reclamacoes/claim-controls.tsx",import.meta.url),"utf8");
  assert.match(ui,/onClick=\{\(\)=>prepare\(action\)\}/);assert.match(ui,/setSelected\(""\)/);
  for(const path of ["../lib/marketplace-case-list.ts","../lib/marketplace-case-detail.ts","../lib/marketplace-case-enrichment.ts"])assert.doesNotMatch(readFileSync(new URL(path,import.meta.url),"utf8"),/get\([^\n]*partial-refund\/available-offers/);
});
