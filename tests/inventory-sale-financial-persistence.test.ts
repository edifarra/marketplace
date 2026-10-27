import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {loadPage} from './helpers/page-harness';
import {saleFinancialPatch} from '../lib/mercado-livre-sale-finance';

test('real registerMarketplaceSale writes finance/dates and runs unchanged inventory transition for this event only',async()=>{
 const writes:any[]=[],rpcs:any[]=[];let previous:any={id:'sale',raw_data:{marker:'keep'}};
 const db:any={from(table:string){let op='select',single=false,body:any;const q:any=new Proxy({}, {get(_t,key:string){
   const result=()=>({data:table==='venda' ? op==='upsert'?{id:'sale'}:previous : table==='status_venda'?{id:'status',reserves_stock:true,releases_stock:false,deducts_physical_stock:false} : table==='listings' || table==='product_marketplaces'?{product_id:'product',products:{sku:'SKU'}}:single?null:table==='venda_item'?[{id:'item',sku:'SKU'}]:[],error:null});
   if(key==='then')return (resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject);
   if(key==='throwOnError')return async()=>result();
   return (...args:any[])=>{if(['insert','update','upsert','delete'].includes(key)){op=key;body=args[0];if(table==='venda'){assert.equal(key,'upsert');assert.equal(body.order_id,'order');writes.push(structuredClone(body));}}if(['single','maybeSingle'].includes(key))single=true;return q;};
 }});return q;},rpc(name:string,args:any){rpcs.push({name,args});return {throwOnError:async()=>({data:[],error:null})};}};
 const mod=loadPage('lib/inventory.ts',{
  crypto,'./supabase-admin':{supabaseAdmin:()=>db},'./mercado-livre-sale-finance':{saleFinancialPatch},
  './sales-fulfillment':{salePostedAt:()=>null},'./marketplace-activity-labels':{activityDescription:()=>''},'./telegram-notifications':{notifyNewSale:async()=>{}},
  './outgoing-activities':{drainOutgoingActivities:async()=>{},enqueueOutgoingActivity:async()=>{}},'./direct-marketplace-publisher':{enqueueDirectListingUpdates:async()=>{}}
 });
 const input={activityId:'event',marketplace:'mercado_livre',externalOrderId:'order',externalEventId:'event',status:'paid',marketplaceAccountId:'account',externalListingId:'listing',items:[{sku:'SKU',quantity:1,unitPrice:29,totalPrice:29}],value:29,shipping:25.99,fees:3.77,soldAt:'2026-01-01T00:00:00Z',paidAt:'2026-01-01T00:00:01Z',finance:{state:'complete',commercial_net:15.02},rawPayload:{order:{id:'order'}}};
 await mod.registerMarketplaceSale(input);
 assert.equal(writes.length,1);assert.equal(writes[0].valor_liquido,15.02);assert.equal(writes[0].data_pagamento,input.paidAt);assert.equal('data_liberacao' in writes[0],false);assert.equal(writes[0].raw_data.marker,'keep');assert.equal(writes[0].raw_data.financial_capture.commercial_net,15.02);
 assert.equal(rpcs.filter(r=>r.name==='reconcile_sale_inventory').length,1);assert.equal(rpcs[0].args.p_reserve,true);
 previous={id:'sale',raw_data:writes[0].raw_data};
 await mod.registerMarketplaceSale({...input,paidAt:null,finance:{state:'partial',commercial_net:null,errors:[{code:'payment_unavailable'}]}});
 assert.equal(writes[1].valor_liquido,15.02);assert.equal('data_pagamento' in writes[1],false);assert.equal(writes[1].raw_data.financial_capture.state,'partial');
});
