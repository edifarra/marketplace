import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('fila persistente: prazos, lease, reinicio, isolamento e RPC antiga preservados', async () => {
  assert.ok(process.env.PGLITE_MODULE, 'Run with scripts/smart-test-runner.mjs');
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  let db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role; create table products(id uuid primary key); create table config_marketplace_accounts(id uuid primary key);');
    await db.exec(readFileSync('supabase/migrations/037_outgoing_marketplace_activities.sql','utf8'));
    await db.exec(readFileSync('supabase/migrations/20261011222103_mercado_livre_picture_followup.sql','utf8'));
    await db.exec(`insert into outgoing_marketplace_activities(destination,activity_type,sku,listing_id,status,attempt_count,photo_confirmation,photo_next_at) values
      ('mercado_livre','listing_update','818PFD','ML-A','completed',5,'{"state":"pending","checks":0}',now()-interval '1 second'),
      ('mercado_livre','listing_update','818PFD','ML-B','completed',1,'{"state":"pending","checks":0}',now()+interval '2 minutes'),
      ('shopee','listing_update','SKU','SHOPEE','queued',0,null,null),
      ('mercado_livre','stock_update','SKU','STOCK','retry',2,null,null);`);
    const old=(await db.query('select * from claim_outgoing_marketplace_activity_queue(10)')).rows;
    assert.deepEqual(old.map(r=>r.listing_id).sort(),['SHOPEE','STOCK']);
    assert.deepEqual(old.map(r=>r.attempt_count).sort(),[1,3]);
    const first=(await db.query('select * from claim_outgoing_marketplace_activity_queue(10,true)')).rows;
    assert.equal(first.length,1); assert.equal(first[0].listing_id,'ML-A');
    assert.equal(first[0].status,'completed'); assert.equal(first[0].attempt_count,5);
    assert.ok(first[0].photo_lease_at);
    assert.equal((await db.query('select * from claim_outgoing_marketplace_activity_queue(10,true)')).rows.length,0);
    const persisted = await db.dumpDataDir();
    await db.close(); db=new PGlite({loadDataDir: persisted});
    assert.equal((await db.query('select * from claim_outgoing_marketplace_activity_queue(10,true)')).rows.length,0);
    await db.exec("update outgoing_marketplace_activities set photo_lease_at=now()-interval '11 minutes' where listing_id='ML-A'");
    const recovered=(await db.query('select * from claim_outgoing_marketplace_activity_queue(10,true)')).rows;
    assert.equal(recovered.length,1); assert.equal(recovered[0].attempt_count,5);
    await db.exec("update outgoing_marketplace_activities set photo_next_at=null,photo_lease_at=null where listing_id='ML-A'");
    await db.exec("update outgoing_marketplace_activities set photo_next_at=now()-interval '1 second' where listing_id='ML-B'");
    assert.equal((await db.query('select * from claim_outgoing_marketplace_activity_queue(10,false)')).rows.length,0);
    const second=(await db.query('select * from claim_outgoing_marketplace_activity_queue(10,true)')).rows;
    assert.equal(second.length,1);assert.equal(second[0].listing_id,'ML-B');
    const acl=(await db.query(`select has_function_privilege('anon','claim_outgoing_marketplace_activity_queue(integer,boolean)','execute') as anon,
      has_function_privilege('authenticated','claim_outgoing_marketplace_activity_queue(integer,boolean)','execute') as authenticated,
      has_function_privilege('service_role','claim_outgoing_marketplace_activity_queue(integer,boolean)','execute') as service`)).rows[0];
    assert.deepEqual(acl,{anon:false,authenticated:false,service:true});
  } finally { await db.close(); }
});
