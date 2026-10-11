import test from "node:test";
import assert from "node:assert/strict";
import { ClaimReturnCostCache,validReturnCost,returnCostLabel } from "../lib/claim-return-cost";
import { CaseReadCache } from "../lib/case-read-cache";
for(const amount of [0,10.99])test(`cost ${amount}`,async()=>{
 const c=new ClaimReturnCostCache();const cost=await c.read('account:case:revision',async()=>({amount,currency_id:'BRL'}));
 assert.equal(cost?.amount,amount);assert.equal(returnCostLabel(cost),amount===0?'Gratuito':'R$ 10,99');
});
for(const status of [401,403,404,503])test(`HTTP ${status} unavailable and not cached`,async()=>{
 const c=new ClaimReturnCostCache();let calls=0;const load=async()=>{calls++;throw new Error(`HTTP ${status}`)};
 assert.equal(await c.read('k',load),null);assert.equal(await c.read('k',load),null);assert.equal(calls,2);
});
for(const value of [{},{amount:null,currency_id:'BRL'},{amount:-1,currency_id:'BRL'},{amount:'0',currency_id:'BRL'},{amount:NaN,currency_id:'BRL'},{amount:0,currency_id:'invalid'}])test(`invalid ${JSON.stringify(value)}`,()=>assert.equal(validReturnCost(value),false));
test('cache deduplicates, partitions account/revision and refreshes modal',async()=>{
 const c=new ClaimReturnCostCache();let calls=0;const load=async()=>{calls++;return {amount:10,currency_id:'BRL'}};
 await Promise.all([c.read('a:1:r',load),c.read('a:1:r',load)]);assert.equal(calls,1);
 await c.read('a:1:r',load);assert.equal(calls,1);
 await c.read('b:1:r',load);await c.read('a:1:r2',load);assert.equal(calls,3);
 await c.read('a:1:r',load,true);assert.equal(calls,4);
});
test('existing cache expires at 15 minutes',async()=>{let now=0,calls=0;const c=new CaseReadCache<number>(()=>now);const load=async()=>++calls;await c.get('k',load);now=900001;await c.get('k',load);assert.equal(calls,2)});
test('modal labels never assume free or promise an exact refund date',()=>{assert.equal(returnCostLabel(null,true),'Não disponível para consulta.');assert.equal(returnCostLabel({amount:0,currency_id:'BRL'},true),'Gratuito para você.')});
