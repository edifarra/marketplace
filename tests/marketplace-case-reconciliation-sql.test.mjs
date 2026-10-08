import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { normalizeCase, transitionState } from '../lib/marketplace-case-domain.ts';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const db = new PGlite();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table config_marketplace_accounts(id uuid primary key,active boolean default true,shop_id text,account_id text,seller_id text);
create table venda(id uuid primary key,marketplace text,order_id text,raw_data jsonb);
create table venda_item(id uuid primary key);create table products(id uuid primary key);
create table marketplace_conversations(id uuid primary key default gen_random_uuid(),marketplace text,marketplace_account_id uuid,order_id text,
conversation_type text constraint marketplace_conversations_conversation_type_check check(conversation_type in ('question','chat','post_sale')),
external_conversation_id text,buyer_id text,buyer_name text,status text,requires_response boolean,external_status text,updated_at timestamptz default now(),unique(marketplace,marketplace_account_id,external_conversation_id));
create table marketplace_conversation_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid references marketplace_conversations,
marketplace_account_id uuid,external_message_id text,external_message_key text,direction text,message_type text,text text,sender_id text,sender_name text,sent_at timestamptz,status text,raw_data jsonb,unique(conversation_id,external_message_id));
create table marketplace_activities(id uuid primary key default gen_random_uuid(),marketplace text,event_type text,external_event_id text,order_id text,description text,status text,source_key text,raw_payload jsonb,processing_error text,next_attempt_at timestamptz,processed_at timestamptz,received_at timestamptz default now(),attempt_count integer default 0,processing_started_at timestamptz,locked_at timestamptz);
create unique index queue_id on marketplace_activities(marketplace,external_event_id) where external_event_id is not null;
`);
for(const file of ['20261005003405_marketplace_cases_stage_one.sql','037_outgoing_marketplace_activities.sql','20261007170807_marketplace_claim_operations.sql','20260929021231_enqueue_marketplace_activity_idempotently.sql','20261008043943_marketplace_case_cache_reconciliation.sql']) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'));
for(let i=1;i<=4;i++)await db.query('insert into config_marketplace_accounts(id)values($1)',[uuid(i)]);
await db.exec(`create table business_write_audit(table_name text);
create function record_business_write()returns trigger language plpgsql as $$begin insert into business_write_audit values(TG_TABLE_NAME);if TG_OP='DELETE'then return old;end if;return new;end$$;
do $$declare t text;begin foreach t in array array['marketplace_cases','marketplace_case_observations','marketplace_case_timeline','marketplace_case_deadlines','marketplace_case_actions','marketplace_case_evidence','marketplace_conversations','marketplace_conversation_messages']loop execute format('create trigger audit_write before insert or update or delete on %I for each row execute function record_business_write()',t);end loop;end$$;`);
const persist = async o => (await db.query('select persist_marketplace_case($1::jsonb) id',[JSON.stringify({...o,state:transitionState(o.snapshot)})])).rows[0].id;
const norm = (account=uuid(1), id='R1', overrides={}) => normalizeCase({id:`event-${Math.random()}`,marketplace:'shopee',received_at:new Date().toISOString(),raw_payload:{code:29,data:{return_sn:id}}},account,
  {return_sn:id,return_status:'PROCESSING',update_time:1790861863,create_time:1790861863,order_sn:'O1',text_reason:'Defeito',refund_amount:29,currency:'BRL',image:['https://example.com/photo.jpg'],return_seller_due_date:1791570065,...overrides});
const stats = async () => (await db.query(`select (select count(*) from marketplace_case_observations) observations,(select count(*) from marketplace_case_evidence) evidence,(select count(*) from marketplace_case_timeline) timeline,(select revision from marketplace_case_cache_revision) revision`)).rows[0];
test('unchanged full detail produces zero business writes and identical updated_at, events, evidence and revision',async()=>{
 const o=norm(); const id=await persist(o);const before=await stats();const updated=(await db.query('select updated_at from marketplace_cases where id=$1',[id])).rows[0].updated_at;
 const same=norm();same.snapshot.enrichment.obtained_at='2099-01-01T00:00:00Z';same.evidence.reverse();same.deadlines[0].value='2026-10-09T15:21:05-03:00';
 await db.exec('truncate business_write_audit');
 await persist(same);assert.equal(Number((await db.query('select count(*) n from business_write_audit')).rows[0].n),0);
 assert.deepEqual(await stats(),before);assert.equal((await db.query('select updated_at from marketplace_cases where id=$1',[id])).rows[0].updated_at.toISOString(),updated.toISOString());
 const change=norm(uuid(1),'R1',{return_seller_due_date:1791570165,image:['https://example.com/photo.jpg','https://example.com/new.jpg']});await persist(change);
 const after=await stats();assert.equal(Number(after.observations),Number(before.observations)+1);assert.equal(Number(after.evidence),Number(before.evidence)+1);
 await persist(change);assert.deepEqual(await stats(),after);
});
test('ML messages and actual status/date changes persist once; equivalent JSON/dates do not rewrite',async()=>{
 const make=(message='Olá',status='opened')=>normalizeCase({id:`ml-${Math.random()}`,marketplace:'mercado_livre',received_at:new Date().toISOString(),raw_payload:{topic:'post_purchase',claim_id:'123'}},uuid(3),{id:'123',status,resource:'order',resource_id:'ML1',last_updated:'2026-10-08T00:00:00Z',players:[],__case_enrichment:{messages:[{hash:'h1',sender_role:'complainant',message,message_date:'2026-10-07T12:00:00Z',status:'available'}],actions:[],statuses:[],reason:{},reputation:{},buyer:null}});
 await persist(make());const before=await stats();await persist(make());assert.deepEqual(await stats(),before);
 await persist(make('Nova mensagem'));assert.equal(Number((await stats()).observations),Number(before.observations)+1);
 const closed=make('Nova mensagem','closed');await persist(closed);const after=await stats();await persist(closed);assert.deepEqual(await stats(),after);
 assert.equal(Number((await db.query("select count(*) n from marketplace_conversation_messages")).rows[0].n),1);
});
test('hourly queue dedup survives repeated schedulers/restart, excludes terminal/unknown/inactive and covers four accounts',async()=>{
 await persist(norm(uuid(2),'R2'));await persist(norm(uuid(4),'R4'));
 for(const n of [3,4])await persist(normalizeCase({id:'ml'+n,marketplace:'mercado_livre',received_at:new Date().toISOString(),raw_payload:{topic:'post_purchase',claim_id:String(100+n)}},uuid(n),{id:String(100+n),status:'opened',resource:'order',resource_id:'ML'+n,last_updated:'2026-10-08T00:00:00Z',players:[],__case_enrichment:{messages:[],actions:[],statuses:[]}}));
 await persist(norm(uuid(1),'closed',{return_status:'CLOSED'}));await persist(norm(uuid(1),'cancelled',{return_status:'CANCELLED'}));await persist(norm(uuid(1),'unknown',{return_status:'FUTURE'}));
 const run=async()=>(await db.query('select claim_marketplace_case_checks($1,20) rows',[uuid(9)])).rows[0].rows;
 const cases=await run();assert.ok(cases.length>0);assert.equal((await run()).length,0);
 assert.equal(new Set(cases.map(c=>c.marketplace_account_id)).size,4);
 assert.equal(Number((await db.query("select count(*) n from marketplace_activities where event_type='case_reconcile'")).rows[0].n),0);
 const statuses=(await db.query("select status from marketplace_cases where id=any($1::uuid[])",[cases.map(c=>c.id)])).rows;assert.ok(statuses.every(s=>!['CLOSED','CANCELLED','FUTURE','closed'].includes(s.status)));
 for(const c of cases)await db.query('select finish_marketplace_case_refresh($1,$2,null)',[c.id,uuid(9)]);
});
test('durable lease excludes webhook/reconciliation overlap, releases after failure and expires after crashed worker',async()=>{
 const id=(await db.query("select id from marketplace_cases where external_case_id='R1'")).rows[0].id;
 const begin=async owner=>(await db.query('select begin_marketplace_case_refresh($1,$2) allowed',[id,owner])).rows[0].allowed;
 assert.equal(await begin(uuid(10)),true);assert.equal(await begin(uuid(11)),false);
 await db.query('select finish_marketplace_case_refresh($1,$2,false)',[id,uuid(10)]);assert.equal(await begin(uuid(11)),true);
 await db.query("update marketplace_case_sync_control set lease_until=now()-interval '1 second' where case_id=$1",[id]);assert.equal(await begin(uuid(12)),true);
 assert.equal((await db.query('select finish_marketplace_case_refresh($1,$2,true) allowed',[id,uuid(11)])).rows[0].allowed,false);
 await db.query('select finish_marketplace_case_refresh($1,$2,true)',[id,uuid(12)]);
 assert.equal((await db.query("select next_due_at>=last_checked_at+interval '60 minutes' valid from marketplace_case_sync_control where case_id=$1",[id])).rows[0].valid,true);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'claim_marketplace_case_checks(uuid,integer)','EXECUTE') allowed",[role])).rows[0].allowed,false);
});
test('real pending webhook suppresses the safety job and queue claim gives notifications priority',async()=>{
 await db.query('update config_marketplace_accounts set shop_id=$1 where id=$2',['100',uuid(1)]);
 const c=(await db.query("select id from marketplace_cases where external_case_id='R1'")).rows[0].id;
 const q=uuid(90);
 await db.query(`insert into marketplace_activities(id,marketplace,event_type,status,raw_payload,next_attempt_at,received_at)
 values($1,'shopee','29','queued','{"shop_id":100,"code":29,"data":{"return_sn":"R1"}}',now(),now())`,[q]);
 await db.query(`insert into marketplace_activities(id,marketplace,event_type,status,raw_payload,next_attempt_at,received_at)
 values($1,'shopee','case_reconcile','queued','{}',now(),now()-interval '1 year')`,[uuid(91)]);
 assert.equal((await db.query('select marketplace_case_has_pending_event($1) pending',[c])).rows[0].pending,true);
 const claimed=(await db.query('select id,event_type from claim_marketplace_activity_queue(1)')).rows;
 assert.equal(claimed[0].id,q);assert.equal(claimed[0].event_type,'29');
});
test('legacy baseline is bootstrapped without a business write; stale detail cannot regress the comparison baseline',async()=>{
 const current=norm(uuid(1),'LEGACY',{image:['https://example.com/photo.jpg','https://example.com/new.jpg']});
 await db.query('select persist_marketplace_case_before_cache($1::jsonb)',[JSON.stringify({...current,state:transitionState(current.snapshot)})]);
 const base=await stats();await db.exec('truncate business_write_audit');await persist(norm(uuid(1),'LEGACY',{image:['https://example.com/photo.jpg','https://example.com/new.jpg']}));
 assert.deepEqual(await stats(),base);assert.equal(Number((await db.query('select count(*) n from business_write_audit')).rows[0].n),0);
 const stable=await stats();await persist(current);assert.deepEqual(await stats(),stable);
 const stale=norm(uuid(1),'LEGACY',{return_status:'CLOSED',update_time:1790861800});stale.order_at='2026-01-01T00:00:00Z';await persist(stale);assert.deepEqual(await stats(),stable);
});
test('100 unchanged probes: 26 RPC calls, 200 control writes, zero queue records/business writes',async()=>{
 await db.exec('update config_marketplace_accounts set active=false');
 const account=uuid(500);await db.query('insert into config_marketplace_accounts(id,active)values($1,true)',[account]);
 const observations=new Map();
 for(let n=0;n<100;n++){const o=norm(account,'ECON'+n);observations.set(await persist(o),o);}
 await db.exec(`create table operational_write_audit(table_name text);
 create function record_operational_write()returns trigger language plpgsql as $$begin insert into operational_write_audit values(TG_TABLE_NAME);return new;end$$;
 create trigger audit_control after insert or update on marketplace_case_sync_control for each row execute function record_operational_write();
 create trigger audit_queue after insert or update on marketplace_activities for each row execute function record_operational_write();
 truncate business_write_audit;`);
 const owner=uuid(501);let calls=0,checked=0;
 for(;;){calls++;const rows=(await db.query('select claim_marketplace_case_checks($1,20) rows',[owner])).rows[0].rows;
  if(!rows.length)break;
  assert.equal((await db.query('select claim_marketplace_case_checks($1,20) rows',[uuid(502)])).rows[0].rows.some(c=>rows.some(r=>r.id===c.id)),false);
  // Release the competing batch after proving it never overlaps.
  await db.query('update marketplace_case_sync_control set lease_owner=null,lease_until=null where lease_owner=$1',[uuid(502)]);
  for(let i=0;i<rows.length;i+=5){calls++;const results=rows.slice(i,i+5).map(c=>({case_id:c.id,observation:observations.get(c.id)}));
   const result=(await db.query('select finish_marketplace_case_checks($1,$2::jsonb) result',[owner,JSON.stringify(results)])).rows[0].result;
   assert.equal(result.queued,0);checked+=result.checked;
  }
 }
 assert.equal(checked,100);assert.equal(calls,26);
 assert.equal(Number((await db.query('select count(*) n from business_write_audit')).rows[0].n),0);
 assert.equal(Number((await db.query("select count(*) n from operational_write_audit where table_name='marketplace_activities'")).rows[0].n),0);
 // Concurrent-claim demonstration above adds control writes: a separate exact fixture below measures 200.
 await db.exec("update marketplace_case_sync_control set next_due_at=now() where case_id in(select id from marketplace_cases where marketplace_account_id='00000000-0000-4000-8000-000000000500');truncate operational_write_audit");
 for(;;){const rows=(await db.query('select claim_marketplace_case_checks($1,20) rows',[owner])).rows[0].rows;if(!rows.length)break;
  for(let i=0;i<rows.length;i+=5)await db.query('select finish_marketplace_case_checks($1,$2::jsonb)',[owner,JSON.stringify(rows.slice(i,i+5).map(c=>({case_id:c.id,observation:observations.get(c.id)})))]);
 }
 assert.equal(Number((await db.query('select count(*) n from operational_write_audit')).rows[0].n),200);
 assert.equal((await db.query('select claim_marketplace_case_checks($1,20) rows',[uuid(503)])).rows[0].rows.length,0);
});

test('precise hash retains nested business source/time, duplicates and sequence; revisions bump once per bundle',async()=>{
 const original=norm(uuid(500),'HASH');const id=await persist(original);
 const fingerprint=async o=>(await db.query('select case_observation_fingerprint($1::jsonb) h',[JSON.stringify(o)])).rows[0].h;
 const hash=await fingerprint(original);
 for(const mutate of [o=>o.snapshot.buyer_description=' Defeito ',o=>o.snapshot.custom={source:'business'},o=>o.snapshot.custom={observed_at:'business'},o=>o.evidence.push(o.evidence[0]),o=>o.evidence[0].metadata.thumbnail_url='https://example.com/new.jpg']){
  const o=structuredClone(original);mutate(o);assert.notEqual(await fingerprint(o),hash);
 }
 const seq=structuredClone(original);seq.snapshot.custom=['first','second'];const reversed=structuredClone(seq);reversed.snapshot.custom.reverse();assert.notEqual(await fingerprint(seq),await fingerprint(reversed));
 const before=Number((await db.query('select revision from marketplace_case_cache_revision')).rows[0].revision);
 const own=Number((await db.query('select case_revision from marketplace_case_sync_control where case_id=$1',[id])).rows[0].case_revision);
 const changed=norm(uuid(500),'HASH',{text_reason:'Atualização legítima sem alterar update_time'});await persist(changed);
 assert.equal(Number((await db.query('select revision from marketplace_case_cache_revision')).rows[0].revision),before+1);
 assert.equal(Number((await db.query('select case_revision from marketplace_case_sync_control where case_id=$1',[id])).rows[0].case_revision),own+1);
});

test('changes and failures enqueue atomically; expired/wrong leases cannot finish or hide work',async()=>{
 const o=norm(uuid(500),'CHANGED');const id=await persist(o);const owner=uuid(600);
 await db.query('select begin_marketplace_case_refresh($1,$2)',[id,owner]);
 const changed=norm(uuid(500),'CHANGED',{return_seller_due_date:1791570165});
 const before=await stats();
 const finish=async results=>(await db.query('select finish_marketplace_case_checks($1,$2::jsonb) result',[owner,JSON.stringify(results)])).rows[0].result;
 assert.equal((await finish([{case_id:id,observation:changed}])).queued,1);assert.deepEqual(await stats(),before);
 assert.equal((await finish([{case_id:id,observation:changed}])).checked,0);
 const job=(await db.query("select raw_payload from marketplace_activities where source_key=$1 order by received_at desc limit 1",['case_reconcile:'+id])).rows[0].raw_payload;
 assert.equal(job.case_observation.deadlines[0].value,changed.deadlines[0].value);
 await persist(job.case_observation);assert.equal(Number((await stats()).observations),Number(before.observations)+1);
 await db.query('select begin_marketplace_case_refresh($1,$2)',[id,owner]);
 assert.equal((await finish([{case_id:id,error:'case_check_failed'}])).queued,1);
 await db.query('select begin_marketplace_case_refresh($1,$2)',[id,owner]);
 await db.query("update marketplace_case_sync_control set lease_until=now()-interval '1 second' where case_id=$1",[id]);
 assert.equal((await finish([{case_id:id,observation:changed}])).checked,0);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'claim_marketplace_case_checks(uuid,integer)','EXECUTE') allowed",[role])).rows[0].allowed,false);
});
test('independent legitimate changes enqueue even with identical claim update_time',async()=>{
 const base=()=>normalizeCase({id:'probe',marketplace:'mercado_livre',received_at:new Date().toISOString(),raw_payload:{topic:'post_purchase',claim_id:'900'}},uuid(500),{
  id:'900',status:'opened',last_updated:'2026-10-08T00:00:00Z',resource:'order',resource_id:'P',players:[],
  __case_enrichment:{messages:[{hash:'msg',sender_role:'complainant',message:'Olá',message_date:'2026-10-07T12:00:00Z',status:'available'}],actions:[],statuses:[],reason:{},reputation:{},buyer:null}});
 const o=base();const id=await persist(o);let n=700;
 for(const mutate of [v=>v.claim_messages[0].text='Outra mensagem',v=>v.claim_messages[0].raw.attachments=[{filename:'nova.jpg'}],v=>v.snapshot.stage='dispute',v=>v.snapshot.reputation_impact='affected',v=>v.snapshot.status='closed',v=>v.snapshot.buyer_data={order_amount:100},v=>v.deadlines=[{purpose:'seller_response',responsible:'seller',value:'2026-10-09T12:00:00Z',precision:'timestamp',validity:'observed'}],v=>v.claim_events.push({key:'resolution',event_type:'Solução aceita',actor:'buyer',official_at:'2026-10-08T01:00:00Z',state:{resolution:'refund'},source:'ml:resolution'})]){
  const changed=base();mutate(changed);const owner=uuid(n++);await db.query('select begin_marketplace_case_refresh($1,$2)',[id,owner]);
  const before=await stats();const result=(await db.query('select finish_marketplace_case_checks($1,$2::jsonb) result',[owner,JSON.stringify([{case_id:id,observation:changed}])])).rows[0].result;
  assert.equal(result.queued,1);assert.deepEqual(await stats(),before);
 }
 const legacy=base();legacy.external_case_id='901';legacy.source_key='legacy-ml';legacy.snapshot.current_claim.id='901';
 await db.query('select persist_marketplace_case_before_cache($1::jsonb)',[JSON.stringify({...legacy,state:transitionState(legacy.snapshot)})]);
 const before=await stats();await db.exec('truncate business_write_audit');await persist(legacy);assert.deepEqual(await stats(),before);
 assert.equal(Number((await db.query('select count(*) n from business_write_audit')).rows[0].n),0);
});
test('A to B to A to B is never hidden by queue dedup; malformed and timezone-free values remain distinct',async()=>{
 const id=await persist(norm(uuid(500),'CYCLE'));const jobIds=[];
 for(let n=0;n<3;n++){
  const owner=uuid(800+n);await db.query('select begin_marketplace_case_refresh($1,$2)',[id,owner]);
  const observation=norm(uuid(500),'CYCLE',{text_reason:n%2===0?'B':'Defeito'});
  const result=(await db.query('select finish_marketplace_case_checks($1,$2::jsonb) result',[owner,JSON.stringify([{case_id:id,observation}])])).rows[0].result;
  assert.equal(result.queued,1);
  const job=(await db.query('select id,raw_payload from marketplace_activities where external_event_id like $1',['case_check:'+id+':'+owner+':%'])).rows[0];
  jobIds.push(job.id);await persist(job.raw_payload.case_observation);await db.query("update marketplace_activities set status='processed' where id=$1",[job.id]);
 }
 assert.equal(new Set(jobIds).size,3);
 const canonical=async v=>(await db.query('select case_business_canonical($1::jsonb) v',[JSON.stringify(v)])).rows[0].v;
 assert.deepEqual(await canonical({at:'2026-99-01T00:00:00Z'}),{at:'2026-99-01T00:00:00Z'});
 assert.notDeepEqual(await canonical({at:'2026-10-08T00:00:00'}),await canonical({at:'2026-10-08T00:00:00Z'}));
});
test.after(()=>db.close());
