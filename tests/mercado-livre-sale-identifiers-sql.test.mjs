import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const account='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const sale='33333333-3333-4333-8333-333333333333';
const second='44444444-4444-4444-8444-444444444444';
const ids=(...values)=>values.map(v=>({identifierType:'PAYMENT_ID',identifierValue:v}));
async function setup(){
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table config_marketplace_accounts(id uuid primary key);
 create table venda(id uuid primary key, marketplace text, order_id text, raw_data jsonb,
 valor_liquido numeric default 23.50, data_pagamento timestamptz, data_liberacao timestamptz);
 insert into config_marketplace_accounts values ('${account}'),('${other}');
 insert into venda values ('${sale}','mercado_livre','order-1','{"marketplace_account_id":"${account}"}',23.50,null,null);`);
 await db.exec(readFileSync('supabase/migrations/20261123170000_create_sale_financial_identifiers.sql','utf8'));
 return db;
}
const envelope=(identifiers,owner=account)=>({marketplace_account_id:owner,payload:{order:{id:'order-1'}},sale_identifiers:{source:'mercado_livre.orders',identifiers}});
const update=(db,identifiers,owner=account)=>db.query('update venda set raw_data=$1 where id=$2',[JSON.stringify(envelope(identifiers,owner)),sale]);
const persist=(db,identifiers,owner=account)=>db.query('select persist_sale_financial_identifiers($1,$2,$3,$4)',[sale,owner,'mercado_livre.orders',JSON.stringify(identifiers)]);

test('no backfill; atomic capture retains previous associations and financial fields',async()=>{
 const db=await setup();try{
  assert.equal((await db.query('select count(*)::int n from venda_financeiro_identificadores')).rows[0].n,0);
  await update(db,ids('a','b'));
  await update(db,ids('b','c'));
  assert.equal((await db.query('select count(*)::int n from venda_financeiro_identificadores')).rows[0].n,3);
  const row=(await db.query('select * from venda where id=$1',[sale])).rows[0];
  assert.equal(row.valor_liquido,'23.50');assert.equal(row.data_pagamento,null);assert.equal(row.data_liberacao,null);
  await assert.rejects(update(db,[...ids('d'),{identifierType:'PAYMENT_ID',identifierValue:''}]));
  assert.deepEqual((await db.query('select raw_data from venda where id=$1',[sale])).rows[0].raw_data,row.raw_data);
  assert.equal((await db.query("select count(*)::int n from venda_financeiro_identificadores where identifier_value='d'")).rows[0].n,0);
 }finally{await db.close();}
});
test('duplicate/concurrent associations are idempotent; shared identifiers allow multiple sales',async()=>{
 const db=await setup();try{
  await Promise.all([persist(db,ids('shared','a')),persist(db,ids('shared','b')),persist(db,ids('shared'))]);
  assert.equal((await db.query('select count(*)::int n from venda_financeiro_identificadores')).rows[0].n,3);
  await db.query('insert into venda(id,marketplace,order_id,raw_data) values($1,$2,$3,$4)',[second,'mercado_livre','order-2',JSON.stringify(envelope(ids('shared')))]);
  assert.equal((await db.query("select count(*)::int n from venda_financeiro_identificadores where identifier_value='shared'")).rows[0].n,2);
 }finally{await db.close();}
});
test('cross-account writes and account reassignment fail; client roles cannot access table or functions',async()=>{
 const db=await setup();try{
  await update(db,ids('a'));
  await assert.rejects(persist(db,ids('foreign'),other));
  await assert.rejects(update(db,ids('foreign'),other));
  await assert.rejects(persist(db,ids('bad'),'99999999-9999-4999-8999-999999999999'));
  for(const role of ['anon','authenticated']){
   await db.exec(`set role ${role}`);
   await assert.rejects(db.query('select * from venda_financeiro_identificadores'));
   await assert.rejects(persist(db,ids('bad')));
   await db.exec('reset role');
  }
  assert.equal((await db.query("select relrowsecurity from pg_class where relname='venda_financeiro_identificadores'")).rows[0].relrowsecurity,true);
 }finally{await db.close();}
});
