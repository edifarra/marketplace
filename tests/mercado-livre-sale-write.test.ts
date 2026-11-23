import test from 'node:test';
import assert from 'node:assert/strict';
import {persistMercadoLivreSale} from '../lib/mercado-livre-sale-write';
function database(current:Record<string,any>|null) {
 let row=current;const calls:string[]=[];let values:any;const filters:Record<string,any>={};
 const query:any={
  update(v:any){calls.push('update');values=v;return query;},
  insert(v:any){calls.push('insert');values=v;return query;},
  select(){return query;},single(){return query;},maybeSingle(){return query;},
  eq(k:string,v:any){filters[k]=v;return query;},
  async throwOnError(){
   if(calls.includes('insert')){if(row)throw new Error('duplicate key');row={id:'sale',...values};return {data:{id:'sale'}};}
   if(!row||Object.entries(filters).some(([k,v])=>row![k]!==v))return {data:null};
   row={...row,...values};return {data:{id:row!.id}};
  }
 };
 return {from:()=>query,calls,get row(){return row;}};
}
test('concurrent newer finance cannot be overwritten by a stale order read',async()=>{
 const db=database({id:'sale',updated_at:'new',valor_liquido:68.73});
 await assert.rejects(persistMercadoLivreSale(db,{valor_liquido:0,updated_at:'later'},{id:'sale',updated_at:'old'}),/Venda alterada/);
 assert.equal(db.row?.valor_liquido,68.73);
});
test('concurrent first insert fails instead of upserting over confirmed history',async()=>{
 const db=database({id:'sale',updated_at:'new',valor_liquido:68.73});
 await assert.rejects(persistMercadoLivreSale(db,{valor_liquido:0}),/duplicate/);
 assert.deepEqual(db.calls,['insert']);assert.equal(db.row?.valor_liquido,68.73);
});
test('matching version updates; missing version aborts before writing; new sale inserts',async()=>{
 const db=database({id:'sale',updated_at:'old',valor_liquido:0});
 await persistMercadoLivreSale(db,{valor_liquido:68.73,updated_at:'new'},{id:'sale',updated_at:'old'});
 assert.equal(db.row?.valor_liquido,68.73);
 const unversioned=database({id:'sale',valor_liquido:68.73});
 await assert.rejects(persistMercadoLivreSale(unversioned,{valor_liquido:0},{id:'sale'}),/sem versão/);
 assert.deepEqual(unversioned.calls,[]);
 const empty=database(null);await persistMercadoLivreSale(empty,{valor_liquido:0,raw_data:{financial_capture:{reconciliation_status:'pending'}}});
 assert.equal(empty.row?.raw_data.financial_capture.reconciliation_status,'pending');
});
