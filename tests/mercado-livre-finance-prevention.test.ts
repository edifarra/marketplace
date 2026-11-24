import {loadPage,elements,memoryDatabase} from './helpers/page-harness';
import {loadAllSalesRows} from '../lib/sales-data';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureSaleFinance,confirmedSaleFinance,approvedOrderShipping,saleNetTotal} from '../lib/mercado-livre-sale-finance';
const order={id:'2000019059510612',currency_id:'BRL',payments:[{id:'ok'},{id:'cancel'},{id:'reject'},{id:'ok'}]};
const approved={id:'ok',collector_id:'seller',order:{id:order.id,type:'mercadolibre'},currency_id:'BRL',status:'approved',transaction_amount:79,shipping_amount:27.99,transaction_details:{net_received_amount:68.73},date_last_updated:'2026-11-20T12:00:00Z',charges_details:[
 {id:'shipping',accounts:{from:'collector',to:'carrier'},amounts:{original:27.99}},
 {id:'ml',accounts:{from:'collector',to:'ml'},amounts:{original:10.19}},
 {id:'mp',accounts:{from:'collector',to:'mp'},amounts:{original:0.08}}
]};
test('proven ML-ED case excludes failed attempts and deduplicates payments',async()=>{
 const calls:string[]=[];
 const f=await captureSaleFinance(order,'seller',async id=>{calls.push(id);return id==='ok'?approved:{...approved,id,status:id==='cancel'?'cancelled':'rejected',shipping_amount:11.99};});
 assert.equal(f.state,'complete');assert.equal(f.commercial_net,68.73);assert.equal(calls.length,3);
 assert.equal(f.commercial_net,68.73);
});
test('partial or failed captures never become sale values, including legacy fallback',()=>{
 for(const finance of [undefined,{state:'partial',commercial_net:108.71},{state:'complete',commercial_net:'NaN'},{state:'complete',commercial_net:108.71,errors:[{code:'unavailable'}]}]) {
  assert.equal(confirmedSaleFinance(finance),undefined);
 }
});
test('multiple approved payments are aggregated once as a payment observation',async()=>{
 const f=await captureSaleFinance({...order,payments:[{id:'ok'},{id:'second'},{id:'second'}]},'seller',async id=>({...approved,id}));
 assert.equal(f.commercial_net,137.46);
 assert.equal(f.payments.length,2);
});
test('no approved payment has no computed payment net, while zero remains a real value',async()=>{
 const f=await captureSaleFinance({...order,payments:[{id:'cancel'}]},'seller',async()=>({...approved,id:'cancel',status:'cancelled'}));
 assert.equal(f.commercial_net,null);
 assert.equal(confirmedSaleFinance({state:'complete',commercial_net:0})?.commercial_net,0);
});
test('existing screens remain untouched and sale registration has no financial capture write',()=>{
 const ui=readFileSync('app/vendas/page.tsx','utf8');
 assert.match(ui,/confirmedSaleFinance\(financial\)/);assert.match(ui,/Aguardando conciliação/);assert.match(ui,/: money\(sale.valor_liquido\)/);
 const inventory=readFileSync('lib/inventory.ts','utf8');assert.doesNotMatch(inventory,/saleFinancialPatch|financialColumns|financialCapture/);
 const reprocess=readFileSync('scripts/reprocess-mercado-livre-sales.mjs','utf8');assert.ok(reprocess.indexOf('throw new Error')<(reprocess.indexOf('loadEnvConfig(process.cwd())') < 0 ? Infinity : reprocess.indexOf('loadEnvConfig(process.cwd())')));
 const audit=readFileSync('scripts/audit-mercado-livre-sales-30d.mjs','utf8');assert.match(audit,/async function saveOrder[^]*?throw new Error/);
 for(const s of [reprocess,audit])assert.doesNotMatch(s,/valor_liquido: value \+/);
});

test('order shipping excludes rejected/cancelled attempts and duplicate approved payments',()=>{
 assert.equal(approvedOrderShipping([{id:'ok',status:'approved',shipping_cost:27.99},{id:'ok',status:'approved',shipping_cost:27.99},{id:'cancel',status:'cancelled',shipping_cost:11.99},{id:'reject',status:'rejected',shipping_cost:11.99}]),27.99);
});
test('dashboard never substitutes old formula or technical zero; Shopee calculation stays unchanged',()=>{
 const ml={marketplace:'mercado_livre',valor_liquido:108.71,raw_data:{financial_capture:{state:'complete',commercial_net:68.73}}};
 const shopee={marketplace:'shopee',valor_produtos:100,valor_taxas:10,valor_descontos:5,valor_frete:20};
 assert.equal(saleNetTotal([ml]),68.73);assert.equal(saleNetTotal([shopee]),65);
 assert.equal(saleNetTotal([ml,shopee]),133.73000000000002);
 assert.equal(saleNetTotal([{...ml,raw_data:{financial_capture:{state:'partial',commercial_net:null}}},shopee]),null);
 assert.equal(saleNetTotal([{...ml,raw_data:{financial_capture:{state:'partial',previous_success:{state:'complete',commercial_net:68.73}}}}]),68.73);
});

test('legacy financial capture remains readable without being rewritten into the sale',()=>{
 const legacy={commercial_net:68.73,basis:'original collector charges; snapshot is not a statement movement',collected_at:'2026-11-20T12:00:00Z'};
 assert.equal(confirmedSaleFinance({state:'partial',previous_success:legacy})?.commercial_net,68.73);
 assert.equal(confirmedSaleFinance({previous_success:{commercial_net:108.71}}),undefined);
});

test('sales page renders pending without technical zero and retains confirmed ML and Shopee values',async()=>{
 const base={status_original:'paid',created_at:'2026-11-20',updated_at:'2026-11-20',valor_produtos:79,valor_frete:27.99,valor_taxas:10.27};
 const db=memoryDatabase({venda:[
  {...base,id:'pending',order_id:'pending',marketplace:'mercado_livre',valor_liquido:0,raw_data:{financial_capture:{state:'partial',reconciliation_status:'pending'}}},
  {...base,id:'confirmed',order_id:'confirmed',marketplace:'mercado_livre',valor_liquido:68.73,raw_data:{financial_capture:{state:'partial',previous_success:{state:'complete',commercial_net:68.73}}}},
  {...base,id:'shopee',order_id:'shopee',marketplace:'shopee',valor_liquido:50,raw_data:{}}
 ]});
 const page=loadPage('app/vendas/page.tsx',{
  '@/lib/supabase-admin':{supabaseAdmin:()=>db},'@/lib/sales-data':{loadAllSalesRows},
  '@/lib/mercado-livre-sale-finance':{confirmedSaleFinance},
  '@/lib/sales-fulfillment':{deferredShipping:()=>null,overduePrintedLabel:()=>false,saleShippingAction:()=>null,saleLabelPrintedAt:()=>null,extractSaleShipping:()=>({})}
 }).default;
 const tree=await page({});const rows=elements(tree).find(n=>Array.isArray(n.props.rows))!.props.rows;
 const net=(id:string)=>rows.find((r:any)=>r.id===id).details.find((d:any)=>/Líquido|líquido/.test(d.label));
 assert.equal(net('pending').value,'Aguardando conciliação');
 assert.match(net('confirmed').value,/68,73/);assert.match(net('shopee').value,/50,00/);
});
