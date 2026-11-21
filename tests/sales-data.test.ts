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
