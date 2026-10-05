// Read-only validation against the existing local application and database.
import assert from "node:assert/strict";
import { supabaseAdmin } from "../lib/supabase-admin";
import { loadCaseList } from "../lib/marketplace-case-list";
import { AUTH_COOKIE_NAME, createSessionToken } from "../lib/auth-session";

async function main() {
  const db = supabaseAdmin();
  const user = await db.from("app_users").select("id,name,is_master,session_version").eq("active", true).limit(1).single().throwOnError();
  const token = await createSessionToken({ sub: user.data.id, name: user.data.name, isMaster: user.data.is_master, sessionVersion: user.data.session_version });
  const headers = { Cookie: `${AUTH_COOKIE_NAME}=${token}` };
  const targets = [];
  for (const [external, account] of [["5587459753", "ML-ED"], ["2610040NPM7U341", "SP-ED"]]) {
    const list = await loadCaseList({ search: external }, db);
    assert.equal(list.total, 1);
    const row = list.rows[0];
    const response = await fetch(`http://localhost:3000/api/central-reclamacoes/${row.id}`, { headers });
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.row.external_case_id, external);
    assert.equal(detail.row.account.name, account);
    assert.equal(detail.row.needs_action, null);
    assert.equal(detail.conversation, null);
    assert.deepEqual(detail.messages, []);
    assert.deepEqual(detail.timeline, []);
    assert.deepEqual(detail.actions, []);
    assert.ok(!JSON.stringify(detail).includes('"raw_data"'));
    const after = await db.from("marketplace_cases").select("updated_at").eq("id", row.id).single().throwOnError();
    assert.equal(after.data.updated_at, row.updated_at);
    targets.push({ external, account, items: detail.items.length, conversation: null, timeline: 0, actions: 0 });
  }
  assert.equal((await fetch("http://localhost:3000/api/central-reclamacoes/invalid", { headers })).status, 400);
  console.log(JSON.stringify({ result: "PASS", targets, caseUpdates: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
