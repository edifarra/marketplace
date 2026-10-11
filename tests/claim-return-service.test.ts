import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), Module=require('node:module');
const original=Module._load;
const id='25c61ca3-777d-4431-86d7-01d3de1718c0',operationId='357656df-5a8c-487a-aa29-1e3900c8bb23';
let rpcError:any=null,calls=0,costCalls=0;
const bundle:any={id:'123',resource:'order',resource_id:'456',status:'opened',last_updated:'r',players:[{role:'complainant',type:'buyer',user_id:'buyer'},{role:'respondent',type:'seller',user_id:'seller',available_actions:[{action:'allow_return'}]}],__case_enrichment:{buyer:{display_name:'Comprador',currency:'BRL',order_amount:100,paid_amount:110,products:[{title:'Produto',quantity:1,amount:100}]}}};
const row={id,external_case_id:'123',order_id:'456',marketplace_account_id:'account',updated_at:'r',content:{current_claim:bundle}};
const db={from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>q,throwOnError:async()=>({data:table==='marketplace_cases'?row:null})};return q;},rpc:async()=>{calls++;return {data:operationId,error:rpcError}}};
Module._load=function(name:string,...args:any[]){
 if(name==='./supabase-admin')return {supabaseAdmin:()=>db};
 if(name==='./mercado-livre')return {getMercadoLivreAccountById:async()=>({active:true,seller_id:'seller'}),getMercadoLivreResource:async()=>{costCalls++;return {amount:0,currency_id:'BRL'}}};
 if(name==='./marketplace-case-enrichment')return {loadMercadoLivreClaimBundle:async()=>bundle};
 return original.call(this,name,...args);
};
const service=require('../lib/marketplace-claim-service');Module._load=original;
process.env.AUTH_SESSION_SECRET='test-only-secret';
test('prepare is read only; successful queue and queue failure are distinguished',async()=>{
 const prepared=await service.prepareClaimAction(id,'allow_return','user');assert.equal(calls,0);assert.equal(prepared.returnCost.amount,0);
 const input={...prepared,operationId,parameters:{}};
 assert.equal(await service.queueClaimOperation(id,input,'user','Operator',db),operationId);assert.equal(calls,1);
 rpcError={message:'database unavailable',code:'mock'};await assert.rejects(service.queueClaimOperation(id,input,'user','Operator',db),/registrar a operação na fila/);
});
test('absent capability prevents cost API reads',async()=>{bundle.players[1].available_actions=[];const before=costCalls;assert.equal(await service.readClaimReturnCost(id),null);assert.equal(costCalls,before)});
