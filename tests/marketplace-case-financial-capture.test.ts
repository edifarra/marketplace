import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMercadoLivreClaimBundle} from '../lib/marketplace-case-enrichment';
import {normalizeCase} from '../lib/marketplace-case-domain';
import {processCaseEvent,persistCaseObservation} from '../lib/marketplace-cases';
const account:any={seller_id:'seller'};
const normalize=(d:any)=>normalizeCase({id:'event',marketplace:'mercado_livre',raw_payload:{topic:'post_purchase',claim_id:'claim'}},'account',d)!;
const root={id:'claim',resource:'shipment',resource_id:'shipment',status:'closed'};
test('shipment claims resolve only a verified unambiguous seller order',async()=>{
 for(const order_ids of [['one'],['one','two']]){
  const bundle=await loadMercadoLivreClaimBundle('claim',account,async path=>path.endsWith('/claims/claim')?root:path.endsWith('/items')?order_ids.map(order_id=>({order_id,sender_id:'seller'})):[]);
  const o=normalize(bundle);assert.equal(o.snapshot.order_id,order_ids.length===1?'one':null);assert.deepEqual(o.snapshot.order_relation.order_ids,order_ids);
 }
 const bundle=await loadMercadoLivreClaimBundle('claim',account,async path=>path.endsWith('/claims/claim')?root:path.endsWith('/items')?[{order_id:'one',sender_id:'other'}]:[]);
 assert.equal(normalize(bundle).snapshot.order_id,null);
});
test('auxiliary failure preserves root/other resources, with sanitized endpoint evidence',async()=>{
 const bundle=await loadMercadoLivreClaimBundle('claim',account,async path=>{
  if(path.endsWith('/claims/claim'))return root;
  if(path.endsWith('/messages'))throw Object.assign(new Error('Bearer secret'),{status:429});
  if(path.endsWith('/items'))return [{order_id:'one',sender_id:'seller'}];
  return [];
 });
 const o=normalize(bundle);assert.equal(o.snapshot.status,'closed');assert.equal(o.snapshot.order_id,'one');assert.equal(o.snapshot.enrichment.state,'partial');
 assert.equal(o.snapshot.enrichment.resources.messages.http_status,429);assert.doesNotMatch(JSON.stringify(o),/Bearer secret/);
});
test('costs are context only, persisted in the same observation, never new debits or buyer refunds',async()=>{
 for(const amount of [12.99,19.99,10.99]){
  const calls:string[]=[];
  const get=async(path:string):Promise<any>=>{calls.push(path);return path.endsWith('/claims/claim')?{...root,resource:'order',resource_id:'order'}:path.endsWith('/return-cost')?{amount,currency_id:'BRL'}:path.endsWith('/affects-reputation')?{affects_reputation:'not_applies'}:[];};
  const bundle=await loadMercadoLivreClaimBundle('claim',account,get,undefined,{financial:true});
  const o=normalize(bundle);assert.equal(o.snapshot.return_cost.amount,amount);assert.equal(o.snapshot.refund_amount,null);assert.equal('signed_amount' in o.snapshot,false);
  assert.equal(o.snapshot.enrichment.state,'complete');assert.equal(calls.filter(p=>p.endsWith('/return-cost')).length,1);
  calls.length=0;await loadMercadoLivreClaimBundle('claim',account,get);assert.equal(calls.some(p=>p.endsWith('/return-cost')),false);
 }
});
test('existing case event persists captured linkage and cost through the real observation RPC, no historical scan',async()=>{
 const sent:any[]=[];
 const db:any={rpc(name:string,args:any){assert.equal(name,'persist_marketplace_case');sent.push(args.p_observation);return {throwOnError:async()=>({data:'case'})};}};
 const detail=await loadMercadoLivreClaimBundle('claim',account,async path=>path.endsWith('/claims/claim')?root:path.endsWith('/items')?[{order_id:'one',sender_id:'seller'}]:path.endsWith('/return-cost')?{amount:12.99,currency_id:'BRL'}:[],undefined,{financial:true});
 await processCaseEvent({id:'current-event',marketplace:'mercado_livre',raw_payload:{topic:'post_purchase',claim_id:'claim'}},'account',{
  persist:o=>persistCaseObservation(o,db),eligible:async()=>true,enriched:async()=>false,enrich:async()=>detail,failure:async()=>{throw new Error('unexpected');},history:async()=>{}
 });
 assert.equal(sent.length,2);assert.equal(sent[1].snapshot.order_id,'one');assert.equal(sent[1].snapshot.return_cost.amount,12.99);assert.equal(sent[1].source_key,'current-event:detail');
});
test('cost observation time is outside the business snapshot, so unchanged existing checks cannot create timestamp-only jobs',async()=>{
 const get=async(path:string):Promise<any>=>path.endsWith('/claims/claim')?{...root,resource:'order',resource_id:'order'}:path.endsWith('/return-cost')?{amount:12.99,currency_id:'BRL'}:path.endsWith('/affects-reputation')?{affects_reputation:'not_applies'}:[];
 const bundle=await loadMercadoLivreClaimBundle('claim',account,get,undefined,{financial:true});
 const first=normalize(bundle).snapshot;
 bundle.__case_enrichment.resources.return_cost.observed_at='2030-01-01T00:00:00Z';
 const second=normalize(bundle).snapshot;
 assert.equal('collected_at' in first.return_cost,false);
 const {enrichment:_a,...a}=first,{enrichment:_b,...b}=second;assert.deepEqual(a,b);
});
