import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const db = new PGlite();
const account="11111111-1111-4111-8111-111111111111", operator="22222222-2222-4222-8222-222222222222";
const conversation="33333333-3333-4333-8333-333333333333";
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create table config_marketplace_accounts(id uuid primary key,active boolean);
  create table app_users(id uuid primary key,active boolean);
  create table products(id uuid primary key);
  create table settings(key text primary key,value jsonb,description text);
  insert into config_marketplace_accounts values('${account}',true);
  insert into app_users values('${operator}',true);
`);
await db.exec(readFileSync(new URL("../supabase/migrations/037_outgoing_marketplace_activities.sql",import.meta.url),"utf8"));
await db.exec(readFileSync(new URL("../supabase/migrations/068_marketplace_chats_questions.sql",import.meta.url),"utf8"));
await db.exec(`insert into marketplace_conversations(id,marketplace,marketplace_account_id,external_conversation_id,conversation_type)
  values('${conversation}','shopee','${account}','4708284056837296129','chat');
  insert into marketplace_conversation_messages(conversation_id,external_message_id,direction,message_type,sent_at,status)
  values('${conversation}','2439066547202146673','incoming','text',now(),'received');`);
await db.exec(readFileSync(new URL("../supabase/migrations/20261005202737_shopee_chat_management_queue.sql",import.meta.url),"utf8"));
const row=async()=>(await db.query("select * from marketplace_conversations where id=$1",[conversation])).rows[0];
const queue=async(action="conversation_read",id="2439066547202146673")=>(await db.query("select enqueue_shopee_conversation_action($1,$2,$3,$4,'Test operator') as id",[conversation,action,id,operator])).rows[0].id;
const finalize=async id=>{
  await db.query("update outgoing_marketplace_activities set confirmed_data=$2 where id=$1",[id,JSON.stringify({shopeeChatReceipt:{request_id:"offline-test",response:{}}})]);
  await db.query("select finalize_shopee_conversation_action($1)",[id]);
  await db.query("update outgoing_marketplace_activities set status='completed' where id=$1",[id]);
};

test("migration executa no PostgreSQL isolado, IDs permanecem exatos e RPCs são service only",async()=>{
  assert.equal((await row()).shopee_last_message_id,"2439066547202146673");
  const permissions=(await db.query(`select has_function_privilege('anon','enqueue_shopee_conversation_action(uuid,text,text,uuid,text)','execute') as anon,
    has_function_privilege('authenticated','finalize_shopee_conversation_action(uuid)','execute') as authenticated,
    has_function_privilege('service_role','enqueue_shopee_conversation_action(uuid,text,text,uuid,text)','execute') as service`)).rows[0];
  assert.deepEqual(permissions,{anon:false,authenticated:false,service:true});
});
test("enfileirar é auditável/idempotente e não marca o chat lido antes de confirmar",async()=>{
  const a=await queue();assert.equal(await queue(),a);
  assert.equal((await row()).unread,true);
  const count=(await db.query("select count(*)::int as n from outgoing_marketplace_activities")).rows[0].n;assert.equal(count,1);
  assert.equal((await db.query("select count(*)::int as n from outgoing_marketplace_activity_history")).rows[0].n,1);
  await assert.rejects(queue("conversation_delete"),/Outra ação/);
  await assert.rejects(db.query("select finalize_shopee_conversation_action($1)",[a]),/sem confirmação/);
  await finalize(a);assert.equal((await row()).unread,false);assert.equal((await row()).requires_response,true);
});
test("sincronização antiga não desfaz leitura e leitura atrasada não apaga mensagem nova",async()=>{
  await db.query("update marketplace_conversations set unread=true where id=$1",[conversation]);assert.equal((await row()).unread,false);
  await db.query("update marketplace_conversations set shopee_last_message_id='2439066547202146674',shopee_last_incoming_message_id='2439066547202146674',unread=true where id=$1",[conversation]);
  assert.equal((await row()).unread,true);
  const a=await queue("conversation_read","2439066547202146674");
  await db.query("update marketplace_conversations set shopee_last_message_id='2439066547202146675',shopee_last_incoming_message_id='2439066547202146675',unread=true where id=$1",[conversation]);
  await finalize(a);assert.equal((await row()).unread,true);
  await db.query("update marketplace_conversations set shopee_last_message_id='2439066547202146673',shopee_last_incoming_message_id='2439066547202146673',unread=false where id=$1",[conversation]);
  assert.equal((await row()).shopee_last_message_id,"2439066547202146675");assert.equal((await row()).unread,true);
});
test("exclusão confirmada filtra página/contagem sem apagar histórico e reabre com mensagem nova",async()=>{
  const a=await queue("conversation_delete","2439066547202146675");await finalize(a);
  assert.ok((await row()).shopee_deleted_at);
  assert.equal((await db.query("select get_marketplace_conversation_page(p_tab=>'all') as page")).rows[0].page.total,0);
  assert.equal((await db.query("select count(*)::int as n from marketplace_conversation_messages")).rows[0].n,1);
  await db.query("update marketplace_conversations set updated_at=clock_timestamp() where id=$1",[conversation]);assert.ok((await row()).shopee_deleted_at);
  await db.query("update marketplace_conversations set shopee_last_message_id='2439066547202146676',shopee_last_incoming_message_id='2439066547202146676',unread=true where id=$1",[conversation]);
  assert.equal((await row()).shopee_deleted_at,null);assert.equal((await row()).unread,true);
  assert.equal((await db.query("select get_marketplace_conversation_page(p_tab=>'all') as page")).rows[0].page.total,1);
});
test("exclusão atrasada preserva nova mensagem e rejeita snapshot de tela desatualizado",async()=>{
  await assert.rejects(queue("conversation_delete","2439066547202146675"),/foi atualizado/);
  const a=await queue("conversation_delete","2439066547202146676");
  await db.query("update marketplace_conversations set shopee_last_message_id='2439066547202146677',shopee_last_incoming_message_id='2439066547202146677',unread=true where id=$1",[conversation]);
  await finalize(a);assert.equal((await row()).shopee_deleted_at,null);
});
test.after(async()=>{await db.close();});
