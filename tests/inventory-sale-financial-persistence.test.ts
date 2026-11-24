import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {loadPage} from './helpers/page-harness';
import {persistMercadoLivreSale} from '../lib/mercado-livre-sale-write';

test('sale registration preserves commercial values and leaves payment snapshots out of sale writes',async()=>{
 const writes:any[]=[],rpcs:any[]=[];let previous:any={id:'sale',updated_at:'2026-01-01T00:00:00Z',raw_data:{marker:'keep',financial_capture:{state:'legacy'}}};
 const db:any={from(table:string){let op='select',single=false,body:any;const q:any=new Proxy({}, {get(_t,key:string){
   const result=()=>({data:table==='venda' ? op==='upsert'?{id:'sale'}:previous : table==='status_venda'?{id:'status',reserves_stock:true,releases_stock:false,deducts_physical_stock:false} : table==='listings' || table==='product_marketplaces'?{product_id:'product',products:{sku:'SKU'}}:single?null:table==='venda_item'?[{id:'item',sku:'SKU'}]:[],error:null});
   if(key==='then')return (resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject);
   if(key==='throwOnError')return async()=>result();
   return (...args:any[])=>{if(['insert','update','upsert','delete'].includes(key)){op=key;body=args[0];if(table==='venda'){assert.equal(key,body.marketplace==='mercado_livre'?'update':'upsert');assert.equal(body.order_id,'order');writes.push(structuredClone(body));}}if(['single','maybeSingle'].includes(key))single=true;return q;};
 }});return q;},rpc(name:string,args:any){rpcs.push({name,args});return {throwOnError:async()=>({data:[],error:null})};}};
 const mod=loadPage('lib/inventory.ts',{
  crypto,'./mercado-livre-sale-write':{persistMercadoLivreSale},'./supabase-admin':{supabaseAdmin:()=>db},
  './sales-fulfillment':{salePostedAt:()=>null},'./marketplace-activity-labels':{activityDescription:()=>''},'./telegram-notifications':{notifyNewSale:async()=>{}},
  './outgoing-activities':{drainOutgoingActivities:async()=>{},enqueueOutgoingActivity:async()=>{}},'./direct-marketplace-publisher':{enqueueDirectListingUpdates:async()=>{}}
 });
 const input={activityId:'event',marketplace:'mercado_livre',externalOrderId:'order',externalEventId:'event',status:'paid',marketplaceAccountId:'account',externalListingId:'listing',items:[{sku:'SKU',quantity:1,unitPrice:29,totalPrice:29}],value:29,shipping:25.99,fees:3.77,soldAt:'2026-01-01T00:00:00Z',paidAt:'2026-01-01T00:00:01Z',finance:{state:'complete',commercial_net:15.02},rawPayload:{order:{id:'order'}}};
 await mod.registerMarketplaceSale(input);
 assert.equal(writes.length,1);assert.equal(writes[0].valor_liquido,input.value + input.shipping - input.fees);assert.equal('data_pagamento' in writes[0],false);assert.equal('data_liberacao' in writes[0],false);assert.equal(writes[0].raw_data.marker,'keep');assert.equal(writes[0].raw_data.financial_capture.state,'legacy');
 assert.equal(rpcs.filter(r=>r.name==='reconcile_sale_inventory').length,1);assert.equal(rpcs[0].args.p_reserve,true);
 previous={id:'sale',updated_at:writes[0].updated_at,raw_data:writes[0].raw_data};
 await mod.registerMarketplaceSale({...input,paidAt:null,finance:{state:'partial',commercial_net:null,errors:[{code:'payment_unavailable'}]}});
 assert.equal(writes[1].valor_liquido,input.value + input.shipping - input.fees);assert.equal('data_pagamento' in writes[1],false);assert.equal(writes[1].raw_data.financial_capture.state,'legacy');
 previous={id:'sale',updated_at:writes[1].updated_at,raw_data:{}};
 await mod.registerMarketplaceSale({...input,marketplace:'shopee',finance:undefined});
 assert.equal(writes[2].valor_liquido,input.value + input.shipping - input.fees);
 assert.equal(writes[2].raw_data.financial_capture,undefined);
 previous={id:'sale',updated_at:writes[2].updated_at,raw_data:{}};
 await mod.registerMarketplaceSale({...input,marketplace:'shopee',value:null,finance:undefined});
 assert.equal(writes[3].valor_liquido,null);
 previous={id:'sale',valor_liquido:13.2,updated_at:writes[3].updated_at,raw_data:{}};
 await mod.registerMarketplaceSale({...input,marketplace:'shopee',value:null,finance:undefined});
 assert.equal(writes[4].valor_liquido,13.2);

});
