import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Optional local PostgreSQL runtime, installed outside application dependencies.
// PGLITE_MODULE must point to @electric-sql/pglite/dist/index.js (smart-test-runner supplies it).
test("SQL executes locally: excludes cases before totals/pagination, preserves normal channels and cursor", async () => {
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table marketplace_conversations (
        id uuid primary key, updated_at timestamptz, marketplace text, marketplace_account_id uuid,
        conversation_type text, status text, requires_response boolean, unread boolean,
        buyer_id text, buyer_name text, product_id uuid, listing_id text, order_id text,
        sku text, product_title text, last_incoming_at timestamptz, last_message_at timestamptz,
        shopee_deleted_at timestamptz
      );`);
    await db.exec(readFileSync("supabase/migrations/20261007233251_separate_chat_and_case_conversations.sql", "utf8"));
    const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    for (let i = 1; i <= 30; i++) {
      await db.query(`insert into marketplace_conversations(id,updated_at,marketplace,marketplace_account_id,conversation_type,status,requires_response,unread,buyer_id,order_id,last_message_at)
        values($1,'2026-10-07T12:00:00Z','shopee',$2,'chat','answered',false,false,$3,'same-order','2026-10-07T12:00:00Z')`, [uuid(i), uuid(i === 30 ? 101 : 100), `buyer-${i}`]);
    }
    await db.query(`insert into marketplace_conversations(id,updated_at,marketplace,marketplace_account_id,conversation_type,status,requires_response,unread,order_id,last_message_at)
      values($1,'2026-10-07T13:00:00Z','mercado_livre',$2,'claim','opened',true,true,'same-order','2026-10-07T13:00:00Z')`, [uuid(999), uuid(100)]);
    const page = async (p = 1, store = null) => (await db.query(`select get_marketplace_conversation_page(p_page => $1,p_tab => 'all',p_store => $2,p_now => '2026-10-07T14:00:00Z') as result`, [p, store])).rows[0].result;
    for (const status of ["opened", "closed", "reopened"]) {
      await db.query("update marketplace_conversations set status=$1 where conversation_type='claim'", [status]);
      const first = await page();
      const second = await page(2);
      assert.equal(first.total, 30);
      assert.equal(first.conversationIds.length, 25);
      assert.equal(second.conversationIds.length, 5);
      assert.ok(!first.conversationIds.includes(uuid(999)));
      assert.equal(new Set([...first.conversationIds, ...second.conversationIds]).size, 30);
      assert.equal(first.cursor.id, uuid(999));
      assert.equal((await page(1, uuid(101))).total, 1);
    }
    await db.query(`insert into marketplace_conversations(id,updated_at,marketplace,marketplace_account_id,conversation_type,status,requires_response,buyer_id,sku,last_message_at)
      values($1,now(),'mercado_livre',$3,'question','pending',true,'same-buyer','SKU','2026-10-07T12:00:00Z'),
      ($2,now(),'mercado_livre',$3,'question','answered',false,'same-buyer','SKU','2026-10-07T12:00:00Z')`, [uuid(50), uuid(51), uuid(100)]);
    assert.equal((await page()).total, 31); // Questions still form one group.
  } finally { await db.close(); }
});
