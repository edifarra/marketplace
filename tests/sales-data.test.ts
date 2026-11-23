import { confirmedSaleFinance } from '../lib/mercado-livre-sale-finance';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAllSalesRows } from '../lib/sales-data';

test('loads items and successful audits beyond the first API page for recent sales', async () => {
  const all = Array.from({length: 1034}, (_, i) => ({venda_id: `sale-${i}`, sku: `SKU-${i}`, status: 'success'}));
  const calls: number[][] = [];
  const loaded = await loadAllSalesRows(async (from, to) => {
    calls.push([from, to]);
    return {data: all.slice(from, to + 1), error: null};
  }, 'venda_item');
  assert.deepEqual(loaded, all);
  assert.deepEqual(calls, [[0,499],[500,999],[1000,1499]]);
  assert.equal(loaded.find(row => row.venda_id === 'sale-1033')?.status, 'success');
});

test('requests the terminal page when total equals the page size', async () => {
  const all = Array.from({length:500}, (_, id) => ({id}));
  let calls = 0;
  assert.equal((await loadAllSalesRows(async (from,to) => {
    calls++;
    return {data:all.slice(from,to+1),error:null};
  }, 'products')).length,500);
  assert.equal(calls,2);
});

test('rejects partial reads and missing responses instead of displaying absent audits', async () => {
  await assert.rejects(loadAllSalesRows(async from => from === 0
    ? {data:Array(500).fill({}),error:null}
    : {data:null,error:{message:'connection failed'}}, 'venda_estoque_auditoria'), /venda_estoque_auditoria: connection failed/);
  await assert.rejects(loadAllSalesRows(async () => ({data:null,error:null}), 'venda_item'), /resposta sem dados/);
});

test('sales page joins recent items and audits across API pages and preserves real audit failures', async () => {
  const {loadPage, elements} = await import('./helpers/page-harness');
  const sales = Array.from({length:1034}, (_, i) => ({id:`sale-${i}`,order_id:`order-${i}`,marketplace:'mercado_livre',raw_data:{},created_at:'2026-11-21',updated_at:'2026-11-21'}));
  const tables: Record<string, any[]> = {
    venda:sales,
    venda_item:sales.map(s=>({venda_id:s.id,sku:s.id,quantidade:1})),
    venda_estoque_auditoria:sales.map((s,i)=>({venda_id:s.id,sku:s.id,status:i===1032?'error':'success',mensagem:i===1032?'Movimento ausente':'Conferido'})),
    products:[], config_marketplace_accounts:[]
  };
  const db = {from(table:string){
    let from=0,to=999;
    const builder:any = new Proxy({}, {get(_target,method){
      if(method==='then') return (resolve:any,reject:any)=>Promise.resolve({data:tables[table].slice(from,to+1),error:null}).then(resolve,reject);
      return (...args:any[])=>{if(method==='range') [from,to]=args;return builder;};
    }});
    return builder;
  }};
  const page=loadPage('app/vendas/page.tsx',{
    '@/lib/supabase-admin':{supabaseAdmin:()=>db},
    '@/lib/mercado-livre-sale-finance':{confirmedSaleFinance},
    '@/lib/sales-data':{loadAllSalesRows},
    '@/lib/sales-fulfillment':{deferredShipping:()=>null,overduePrintedLabel:()=>false,saleShippingAction:()=>null,saleLabelPrintedAt:()=>null,extractSaleShipping:()=>({})}
  }).default;
  const tree=await page({});
  const rows=elements(tree).find(n=>Array.isArray(n.props.rows))!.props.rows;
  assert.equal(rows.length,1034);
  const latest=rows.find((r:any)=>r.id==='sale-1033');
  assert.equal(latest.totalItems,1);
  assert.equal(latest.inventoryAudit.status,'success');
  const failed=rows.find((r:any)=>r.id==='sale-1032');
  assert.equal(failed.inventoryAudit.status,'error');
  assert.equal(failed.inventoryAudit.title,'Movimento ausente');
});
