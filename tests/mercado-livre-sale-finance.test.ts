import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureSaleFinance,saleFinancialPatch,financialCents,isNonReceivingTerminalPayment,paymentReleaseClass} from '../lib/mercado-livre-sale-finance';
const order={id:'order',currency_id:'BRL',payments:[{id:'payment',status:'approved',date_approved:'2026-09-30T23:09:35-04:00'}]};
const payment={id:'payment',collector_id:'seller',order:{id:'order',type:'mercadolibre'},currency_id:'BRL',status:'approved',transaction_amount:29,shipping_amount:25.99,money_release_date:'2026-10-15T10:18:28-03:00',money_release_status:'released',transaction_details:{net_received_amount:15.02},charges_details:[
 {id:'shipping',name:'shp_cross_docking',accounts:{from:'collector',to:'carrier'},amounts:{original:36.2,refunded:0}},
 {id:'processing',accounts:{from:'collector',to:'mp'},amounts:{original:0.03}},
 {id:'sale',accounts:{from:'collector',to:'ml'},amounts:{original:3.74}}
]};
test('original charges explain 51.22 versus 15.02 in the same sale trigger',async()=>{
 const calls:string[]=[];const f=await captureSaleFinance(order,'seller',async id=>{calls.push(id);return payment;});
 assert.deepEqual(calls,['payment']);assert.equal(f.commercial_net,15.02);assert.equal(f.state,'complete');
 assert.equal(f.approved_at,'2026-10-01T03:09:35.000Z');assert.equal(f.effective_release_at,'2026-10-15T13:18:28.000Z');
 const patch=saleFinancialPatch({finance:f,paidAt:f.approved_at},{});
 assert.equal(patch.valor_liquido,15.02);assert.equal(patch.data_pagamento,'2026-10-01T03:09:35.000Z');assert.equal('data_liberacao' in patch,false);
});
test('release date requires every payment to be released with a valid timestamp and uses the latest release',async()=>{
 const multi={...order,payments:[{id:'payment',status:'approved'},{id:'payment-2',status:'approved'}]};
 const second={...payment,id:'payment-2',money_release_date:'2026-10-16T10:18:28-03:00'};
 const released=await captureSaleFinance(multi,'seller',async id=>id==='payment'?payment:second);
 assert.equal(released.effective_release_at,'2026-10-16T13:18:28.000Z');
 const pending=await captureSaleFinance(multi,'seller',async id=>id==='payment'?payment:{...second,money_release_status:'pending'});
 assert.equal(pending.effective_release_at,null);
 const invalid=await captureSaleFinance(order,'seller',async()=>({...payment,money_release_date:'tomorrow'}));
 assert.equal(invalid.effective_release_at,null);
 const missing=await captureSaleFinance(multi,'seller',async id=>{if(id==='payment-2')throw new Error('unavailable');return payment;});
 assert.equal(missing.effective_release_at,null);
});
test('terminal cancelled and rejected attempts are ignored only with explicit zero receipt and no conflicting evidence',async()=>{
 const officialRelease='2026-11-02T13:28:21-04:00';
 const failed=(id:string,status:'cancelled'|'rejected',overrides:Record<string,unknown>={})=>({
  id,collector_id:'seller',order:{id:'order',type:'mercadolibre'},currency_id:'BRL',status,
  transaction_amount:11.99,transaction_details:{net_received_amount:0},transaction_amount_refunded:null,
  ...overrides
 });
 const orderWithAttempts={...order,date_last_updated:'2026-11-02T17:29:00Z',payments:[...order.payments,
  {id:'cancelled',status:'cancelled'},{id:'rejected',status:'rejected'}]};
 const result=await captureSaleFinance(orderWithAttempts,'seller',async id=>{
  if(id==='payment')return {...payment,money_release_date:officialRelease};
  return failed(id,id==='cancelled'?'cancelled':'rejected');
 });
 assert.equal(result.effective_release_at,'2026-11-02T17:28:21.000Z');
 assert.deepEqual(result.order_payment_ids,['payment','cancelled','rejected']);
 assert.equal(result.order_api_updated_at,'2026-11-02T17:29:00.000Z');
 assert.equal(isNonReceivingTerminalPayment({status:'cancelled',net_received_amount:0}),true);
 for(const evidence of [
  {status:'rejected',net_received_amount:null},
  {status:'cancelled',net_received_amount:0,transaction_amount_refunded:1},
  {status:'rejected',net_received_amount:0,date_approved:'2026-11-02T17:00:00Z'},
  {status:'cancelled',net_received_amount:0,money_release_status:'released'},
  {status:'rejected',net_received_amount:0,money_release_date:'2026-11-02T17:00:00Z'},
  {status:'approved',net_received_amount:0}
 ]) assert.equal(isNonReceivingTerminalPayment(evidence),false);
 assert.equal(paymentReleaseClass({status:'cancelled',net_received_amount:null}), 'blocked_terminal_ambiguous');
 const contradictory=await captureSaleFinance({...order,payments:[{id:'cancelled',status:'cancelled'}]},'seller',async()=>failed('cancelled','cancelled',{
  money_release_status:'released',money_release_date:'2026-11-02T17:28:21Z'
 }));
 assert.equal(contradictory.effective_release_at,null);
});
test('only terminal attempts cannot prove a release; partial and refund/dispute payments remain relevant',async()=>{
 const terminalOrder={...order,payments:[{id:'cancelled',status:'cancelled'}]};
 const cancelled=await captureSaleFinance(terminalOrder,'seller',async()=>({
  id:'cancelled',collector_id:'seller',order:{id:'order',type:'mercadolibre'},currency_id:'BRL',status:'cancelled',
  transaction_details:{net_received_amount:0},transaction_amount_refunded:null
 }));
 assert.equal(cancelled.effective_release_at,null);
 for(const status of ['refunded','in_mediation','charged_back']){
  const result=await captureSaleFinance({...order,payments:[{id:'payment',status}]},'seller',async()=>({...payment,status}));
  assert.equal(result.effective_release_at,'2026-10-15T13:18:28.000Z',`${status} retains the existing released-date treatment`);
 }
 const partial=await captureSaleFinance({...order,payments:[{id:'payment',status:'approved'},{id:'pending',status:'pending'}]},'seller',async id=>id==='payment'?payment:{...payment,id:'pending',status:'pending',money_release_status:'pending'});
 assert.equal(partial.effective_release_at,null);
});
test('failure/identity mismatch/unknown deductions remain incomplete and cannot erase a valid liquid',async()=>{
 for(const read of [async()=>{throw new Error('Bearer secret');},async()=>({...payment,collector_id:'other'}),async()=>({...payment,transaction_details:{net_received_amount:0}})]){
  const f=await captureSaleFinance(order,'seller',read);assert.equal(f.commercial_net,null);assert.equal(f.state,'partial');assert.doesNotMatch(JSON.stringify(f),/Bearer secret/);
  const p=saleFinancialPatch({finance:f},{financial_capture:{state:'complete',commercial_net:15.02}});assert.equal(p.valor_liquido,15.02);
  assert.equal(saleFinancialPatch({finance:f},{financial_capture:p.raw}).valor_liquido,15.02);
 }
});
test('financing credit/debit cancel, recovered charges are never counted as a second refund',async()=>{
 const pairs=[{id:'fin-fee',accounts:{from:'collector',to:'mp'},amounts:{original:5,refunded:5}},{id:'fin-credit',accounts:{from:'mp',to:'collector'},amounts:{original:5,refunded:5}}];
 const f=await captureSaleFinance(order,'seller',async()=>({...payment,charges_details:[...payment.charges_details,...pairs]}));assert.equal(f.commercial_net,15.02);
 const missing=await captureSaleFinance(order,'seller',async()=>({...payment,charges_details:null}));assert.equal(missing.commercial_net,null);
 assert.equal(financialCents(null),null);assert.equal(financialCents('1.234'),null);assert.equal(financialCents('0.10'),10);
});
test('late refund/dispute snapshots preserve the original commercial sale instead of subtracting refund costs again',async()=>{
 for(const fields of [{status:'refunded'},{status:'in_mediation'},{transaction_amount_refunded:1}]){
  const f=await captureSaleFinance(order,'seller',async()=>({...payment,...fields}));assert.equal(f.commercial_net,null);
  assert.equal(saleFinancialPatch({finance:f},{financial_capture:{state:'complete',commercial_net:15.02}}).valor_liquido,15.02);
 }
});
test('finance is captured before registration, and no scheduler/page consumes the capture helper',()=>{
 const flow=readFileSync('lib/mercado-livre-orders.ts','utf8');assert.ok(flow.indexOf('await captureSaleFinance')<flow.indexOf('return registerMarketplaceSale'));
 for(const path of ['scripts/marketplace-worker.ts','lib/marketplace-case-reconciliation.ts','app/vendas/page.tsx'])assert.doesNotMatch(readFileSync(path,'utf8'),/captureSaleFinance|api\.mercadopago/);
 assert.doesNotMatch(readFileSync('lib/mercado-livre-sale-finance.ts','utf8'),/setInterval|setTimeout|\.from\(|\.update\(|\.upsert\(/);
});
