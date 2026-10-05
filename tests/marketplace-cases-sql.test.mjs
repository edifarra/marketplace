import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
test.after(async () => { await db.close(); });
