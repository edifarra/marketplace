import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizeCase, transitionState } from "../lib/marketplace-case-domain.ts";
import { caseContext, globalCaseAlert } from "../lib/marketplace-case-context.ts";

// Isolated PostgreSQL engine, not Supabase. Set PGLITE_MODULE to a temporary installation's dist/index.js.
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const db = new PGlite();
const account = "11111111-1111-4111-8111-111111111111";
const sale = "22222222-2222-4222-8222-222222222222";
const chat = "33333333-3333-4333-8333-333333333333";
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create table config_marketplace_accounts(id uuid primary key);
  create table venda(id uuid primary key,marketplace text,order_id text,raw_data jsonb);
  create table venda_item(id uuid primary key);
  create table products(id uuid primary key);
  create table marketplace_conversations(id uuid primary key,marketplace text,marketplace_account_id uuid,order_id text,conversation_type text);
  insert into config_marketplace_accounts values('${account}');
  insert into venda values('${sale}','shopee','O1','{"marketplace_account_id":"${account}"}');
  insert into marketplace_conversations values('${chat}','shopee','${account}','OTHER','chat');
`);
await db.exec(readFileSync(new URL("../supabase/migrations/20261005003405_marketplace_cases_stage_one.sql", import.meta.url), "utf8"));
const o = (id = "R1", key = "a", status = "OPENED", time = "2026-10-04T12:00:00Z") => ({
  marketplace: "shopee", marketplace_account_id: account, case_type: "return", external_case_id: id,
  source: "test", source_key: key, observed_at: time, official_at: time, order_at: time,
  state: { status, stage: null, responsible: "unknown", logistics_status: null, resolution: null },
  snapshot: { order_id: "O1", status, stage: null, responsible: "unknown", needs_action: null,
    reputation_impact: "not_affected", resolution: null, reverse_logistics: { status: null }, enrichment: { state: "incomplete" } },
  deadlines: [], actions: [], evidence: []
});
const persist = async v => (await db.query("select persist_marketplace_case($1::jsonb) as id", [JSON.stringify(v)])).rows[0].id;
const count = async table => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);

test("migration executes and SQL uniqueness/idempotent timeline/unknown values are enforced", async () => {
  const first = await persist(o());
  assert.equal(await persist(o()), first);
  assert.equal(await persist(o("R1", "b")), first);
  assert.equal(await count("marketplace_cases"), 1);
  assert.equal(await count("marketplace_case_observations"), 2);
  assert.equal(await count("marketplace_case_timeline"), 1);
  const row = (await db.query("select * from marketplace_cases where id=$1", [first])).rows[0];
  assert.equal(row.venda_id, sale); assert.equal(row.conversation_id, null);
  assert.equal(row.needs_action, null); assert.equal(row.reputation_impact, "unknown");
  assert.notEqual(await persist(o("R2", "c")), first);
  assert.equal(await count("marketplace_cases"), 2);
});
test("SQL multiple ML deliveries retain one Claim", async () => {
  const a = { ...o("123", "ml-a"), marketplace: "mercado_livre", case_type: "claim" };
  assert.equal(await persist(a), await persist({ ...a, source_key: "ml-b" }));
});
test("new enrichment and older delivery cannot duplicate or regress current status", async () => {
  const id = await persist(o("R1", "detail", "ACCEPTED", "2026-10-04T13:00:00Z"));
  await persist(o("R1", "old", "OLD", "2026-10-04T11:00:00Z"));
  assert.equal((await db.query("select status from marketplace_cases where id=$1", [id])).rows[0].status, "ACCEPTED");
  await persist(o("R1", "detail", "ACCEPTED", "2026-10-04T13:00:00Z"));
  assert.equal(Number((await db.query("select count(*) n from marketplace_case_timeline where case_id=$1 and state->>'status'='ACCEPTED'", [id])).rows[0].n), 1);
});
test("saved mediation identity alone does not erase known capabilities or enrichment", async () => {
  const a = o("R5", "known"); a.snapshot.needs_action = true; a.snapshot.enrichment = { state: "partial" };
  const id = await persist(a);
  const identity = o("R5", "mediation", null, "2026-10-04T14:00:00Z"); identity.identity_only = true;
  await persist(identity);
  const row = (await db.query("select status,needs_action,enrichment from marketplace_cases where id=$1", [id])).rows[0];
  assert.equal(row.status, "OPENED"); assert.equal(row.needs_action, true); assert.equal(row.enrichment.state, "partial");
});
test("duplicate observation can hydrate a sale created after the return push without a new timeline step", async () => {
  const a = o("R6", "late-sale"); a.snapshot.order_id = "LATE";
  const id = await persist(a);
  assert.equal((await db.query("select venda_id from marketplace_cases where id=$1", [id])).rows[0].venda_id, null);
  await db.exec(`insert into venda values('44444444-4444-4444-8444-444444444444','shopee','LATE','{"marketplace_account_id":"${account}"}')`);
  await persist(a);
  assert.equal((await db.query("select venda_id from marketplace_cases where id=$1", [id])).rows[0].venda_id, "44444444-4444-4444-8444-444444444444");
  assert.equal(Number((await db.query("select count(*) n from marketplace_case_timeline where case_id=$1", [id])).rows[0].n), 1);
});
test("deadline/action/evidence snapshots are transactional and idempotent", async () => {
  const a = o("R3", "rich");
  a.deadlines = [{ purpose: "unknown", responsible: "unknown", value: "2026-10-05", precision: "date", timezone: null,
    source: "official", validity: "observed", official_field: "due_date" }];
  a.actions = [{ code: "offer_refund", mandatory: false, deadline: null, observed_at: a.observed_at, parameters: { max_amount: 20 } }];
  a.evidence = [{ media_type: "image", reference: "official-attachment-id", metadata: { mime_type: "image/jpeg" } }];
  await persist(a); await persist(a);
  for (const t of ["deadlines", "actions", "evidence"]) assert.equal(await count(`marketplace_case_${t}`), 1);
  assert.equal((await db.query("select purpose from marketplace_case_deadlines")).rows[0].purpose, "unknown");
  const bad = o("BAD", "bad"); bad.evidence = [{ media_type: "unsupported", reference: "x", metadata: {} }];
  await assert.rejects(persist(bad));
  assert.equal(Number((await db.query("select count(*) n from marketplace_cases where external_case_id='BAD'")).rows[0].n), 0);
});
test("case survives conversation retention and all new tables/functions are service-only", async () => {
  await db.exec(`update marketplace_conversations set order_id='O1' where id='${chat}'`);
  const id = await persist(o("R4", "linked"));
  assert.equal((await db.query("select conversation_id from marketplace_cases where id=$1", [id])).rows[0].conversation_id, chat);
  await db.exec(`delete from marketplace_conversations where id='${chat}'`);
  assert.equal((await db.query("select conversation_id from marketplace_cases where id=$1", [id])).rows[0].conversation_id, null);
  const tables = (await db.query("select relname,relrowsecurity from pg_class where relname like 'marketplace_case%' and relkind='r'")).rows;
  assert.equal(tables.length, 7); assert.ok(tables.every(t => t.relrowsecurity));
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await db.query("select has_function_privilege($1,'persist_marketplace_case(jsonb)','EXECUTE') allowed", [role])).rows[0].allowed, false);
    for (const t of tables) assert.equal((await db.query("select has_table_privilege($1,$2,'SELECT') allowed", [role,t.relname])).rows[0].allowed, false);
  }
  assert.equal((await db.query("select has_function_privilege('service_role','persist_marketplace_case(jsonb)','EXECUTE') allowed")).rows[0].allowed, true);
});
test("claim to actual return retains SQL identity, earlier history, logistics and seller deadline ownership without schema changes", async () => {
  const observation = (event, data, at) => {
    const normalized = normalizeCase({ id: event, marketplace: "mercado_livre", received_at: at,
      raw_payload: { topic: "post_purchase", claim_id: "TRANSITION1", claim: data } }, account);
    return { ...normalized, state: transitionState(normalized.snapshot) };
  };
  const first = observation("first", { status: "open" }, "2026-10-05T10:00:00Z");
  const id = await persist(first);
  const before = (await db.query("select id from marketplace_case_timeline where case_id=$1", [id])).rows;
  const next = observation("second", { status: "open", related_entities: [{ type: "return", id: "REAL1" }],
    reverse_logistics: { contact_name: "Maria Retorno", tracking: "BR123", carrier: "Correios" },
    players: [{ role: "respondent", type: "seller", available_actions: [{ action: "return_review", mandatory: true, due_date: "2026-10-06T10:00:00Z" }] }] }, "2026-10-05T11:00:00Z");
  assert.equal(await persist(next), id);
  const row = (await db.query("select * from marketplace_cases where id=$1", [id])).rows[0];
  assert.equal(row.case_type, "claim"); assert.equal(caseContext(row), "return"); assert.equal(globalCaseAlert(row), false);
  assert.equal(row.content.related_claim_id, "TRANSITION1"); assert.equal(row.reverse_logistics.contact_name, "Maria Retorno");
  assert.equal(row.reverse_logistics.tracking, "BR123"); assert.equal(row.reverse_logistics.carrier, "Correios");
  const after = (await db.query("select id from marketplace_case_timeline where case_id=$1", [id])).rows;
  assert.ok(before.every(event => after.some(saved => saved.id === event.id))); assert.equal(after.length, before.length + 1);
  const deadlines = (await db.query("select responsible,purpose from marketplace_case_deadlines where case_id=$1", [id])).rows;
  assert.deepEqual(deadlines, [{ responsible: "seller", purpose: "action:return_review" }]);
  // Partial future pushes must retain the established logistics rather than move back to Claims.
  await persist(observation("partial", { status: "open" }, "2026-10-05T12:00:00Z"));
  const partial = (await db.query("select * from marketplace_cases where id=$1", [id])).rows[0];
  assert.equal(caseContext(partial), "return"); assert.equal(partial.reverse_logistics.return_id, "REAL1");
});

test.after(async () => { await db.close(); });

test("local claim migration: isolated chat/messages, current snapshots, operation equivalence and send barrier",async()=>{
  await db.exec(`
    alter table marketplace_conversations alter column id set default gen_random_uuid();
    alter table marketplace_conversations add column external_conversation_id text,add column buyer_id text,add column buyer_name text,
      add column status text,add column requires_response boolean,add column external_status text,add column updated_at timestamptz default now(),
      add constraint marketplace_conversations_conversation_type_check check(conversation_type in ('question','chat','post_sale')),
      add unique(marketplace,marketplace_account_id,external_conversation_id);
    create table marketplace_conversation_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid references marketplace_conversations(id),
      marketplace_account_id uuid,external_message_id text,external_message_key text,direction text,message_type text,text text,sender_id text,sender_name text,sent_at timestamptz,status text,raw_data jsonb,
      unique(conversation_id,external_message_id));
  `);
  await db.exec(readFileSync(new URL("../supabase/migrations/037_outgoing_marketplace_activities.sql",import.meta.url),"utf8"));
  await db.exec(readFileSync(new URL("../supabase/migrations/20261007170807_marketplace_claim_operations.sql",import.meta.url),"utf8"));
  const enriched={id:"SQLCLAIM",resource:"order",resource_id:"O1",status:"opened",last_updated:"2026-10-07T12:00:00Z",date_created:"2026-10-07T11:00:00Z",players:[],
    __case_enrichment:{reason:{name:"repentant_buyer",detail:"Motivo humano"},reputation:{affects_reputation:"not_applies"},buyer:{id:"B",display_name:"Nome",site_id:"MLB",legal_name:"Empresa Fiscal"},
      messages:[{hash:"hash1",sender_role:"complainant",receiver_role:"respondent",message:"Mensagem pessoal LEDs",message_date:"2026-10-07T11:00:01Z",status:"available",attachments:[{filename:"photo.jpg",size:42,type:"image/jpeg"}]}],
      actions:[{action_name:"open_claim",player_role:"complainant",date_created:"2026-10-07T11:00:00Z"}],statuses:[],resolutions:[]}};
  const normalize=(event,caseId="SQLCLAIM")=>{const n=normalizeCase({id:event,marketplace:"mercado_livre",received_at:"2026-10-07T12:01:00Z",raw_payload:{topic:"post_purchase",claim_id:caseId}},account,{...enriched,id:caseId});return {...n,state:transitionState(n.snapshot)};};
  const id=await persist(normalize("webhook"));await persist(normalize("reconcile"));await persist(normalize("confirm"));
  const row=(await db.query("select * from marketplace_cases where id=$1",[id])).rows[0];assert.equal(row.reputation_impact,"not_applies");assert.equal(row.content.buyer_data.legal_name,"Empresa Fiscal");
  assert.equal(row.content.claim_messages,undefined);assert.equal(row.content.claim_events,undefined);
  const chat=(await db.query("select * from marketplace_conversations where id=$1",[row.conversation_id])).rows[0];assert.equal(chat.conversation_type,"claim");assert.equal(chat.external_conversation_id,"claim:SQLCLAIM");
  assert.equal(Number((await db.query("select count(*) n from marketplace_conversation_messages where conversation_id=$1",[row.conversation_id])).rows[0].n),1);
  const message=(await db.query("select raw_data,text from marketplace_conversation_messages where conversation_id=$1",[row.conversation_id])).rows[0];assert.equal(message.text,"Mensagem pessoal LEDs");assert.equal(message.raw_data.attachments.length,1);
  const second=await persist(normalize("other-claim","SQLCLAIM2"));assert.notEqual((await db.query("select conversation_id from marketplace_cases where id=$1",[second])).rows[0].conversation_id,row.conversation_id);
  const enqueue=async(op,request={operatorId:"operator",action:"refund",parameters:{},fingerprint:"same-revision-and-action"})=>(await db.query("select enqueue_marketplace_claim_operation($1,$2,$3) id",[id,op,JSON.stringify(request)])).rows[0].id;
  const op="77777777-7777-4777-8777-777777777777",duplicate="88888888-8888-4888-8888-888888888888";
  const concurrent=await Promise.all([enqueue(op),enqueue(duplicate)]);assert.equal(concurrent[0],concurrent[1]);assert.equal(await enqueue(op),op);
  await assert.rejects(enqueue(op,{operatorId:"other-user",action:"refund",parameters:{},fingerprint:"same-revision-and-action"}));
  await assert.rejects(enqueue("99999999-9999-4999-8999-999999999999",{operatorId:"operator",action:"allow_return",parameters:{},fingerprint:"different-action"}));
  await db.query("update outgoing_marketplace_activities set status='processing' where id=$1",[op]);
  const send=async()=>(await db.query("select begin_marketplace_claim_send($1) allowed",[op])).rows[0].allowed;
  assert.equal(await send(),true);assert.equal(await send(),false);
  await db.query("update outgoing_marketplace_activities set status='error',remote_execution_state='uncertain' where id=$1",[op]);
  await assert.rejects(enqueue("99999999-9999-4999-8999-999999999999",{operatorId:"operator",action:"allow_return",parameters:{},fingerprint:"different-action"}));
  for(const role of ["anon","authenticated"])assert.equal((await db.query("select has_function_privilege($1,'enqueue_marketplace_claim_operation(uuid,uuid,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
  await assert.rejects(enqueue("99999999-9999-4999-8999-999999999999",{operatorId:"operator",action:"open_dispute",parameters:{},fingerprint:"forbidden"}));
});
