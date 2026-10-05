// Read-only live validation. Run with .env.local and the existing server-only shim.
import assert from "node:assert/strict";
import { supabaseAdmin } from "../lib/supabase-admin";
import { caseGroup, loadCaseList } from "../lib/marketplace-case-list";
import { AUTH_COOKIE_NAME, createSessionToken } from "../lib/auth-session";

async function main() {
  const originalFetch = globalThis.fetch;
  const dbHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  let databaseRequests = 0;
  const tables = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    assert.ok([dbHost, "localhost:3000"].includes(url.host), `Unexpected external host: ${url.host}`);
    assert.ok(["GET", "HEAD"].includes(method), `Unexpected mutation: ${method}`);
    if (url.host === dbHost) { databaseRequests++; tables.add(url.pathname.split("/").at(-1)!); }
    return originalFetch(input, init);
  };
  try {
    const db = supabaseAdmin();
    const first = await loadCaseList({}, db);
    const returns = await loadCaseList({ context: "return" }, db);
    assert.equal(first.total + returns.total, 144);
    const all = [...first.rows, ...returns.rows];
    for (const context of ["claim", "return"]) {
      const initial = context === "claim" ? first : returns;
      for (let page = 2; page <= initial.pages; page++) all.push(...(await loadCaseList({ context, page: String(page) }, db)).rows);
    }
    assert.equal(all.length, 144);
    assert.equal(new Set(all.map(r => r.id)).size, 144);
    assert.equal(new Set(all.map(r => [r.marketplace, r.marketplace_account_id, r.case_type, r.external_case_id].join(":"))).size, 144);
    assert.equal(all.filter(r => r.marketplace === "mercado_livre").length, 100);
    assert.equal(all.filter(r => r.marketplace === "shopee").length, 44);
    assert.ok(all.every(r => r.account?.id === r.marketplace_account_id && r.account?.marketplace === r.marketplace));
    assert.ok(all.every(r => r.needs_action === null && caseGroup(r) === "unknown"));
    assert.ok(first.rows.every(r => r.case_type === "claim"));
    assert.ok(returns.rows.every(r => r.case_type === "return"));
    const expectedAccounts: Record<string, number> = { "ML-ED": 54, "ML-GI": 46, "SP-ED": 27, "SP-GI": 17 };
    for (const account of first.accounts) {
      const expected = expectedAccounts[account.name];
      assert.equal((await loadCaseList({ account: account.id }, db)).total + (await loadCaseList({ account: account.id, context: "return" }, db)).total, expected);
    }
    assert.equal((await loadCaseList({ marketplace: "mercado_livre" }, db)).total, 100);
    assert.equal((await loadCaseList({ marketplace: "shopee", context: "return" }, db)).total, 44);
    for (const tab of ["action", "ongoing", "closed"]) assert.equal((await loadCaseList({ tab }, db)).total, 0);
    for (const search of ["5587459753", "2610040NPM7U341"]) {
      const r = await loadCaseList({ search, context: search === "2610040NPM7U341" ? "return" : "claim" }, db);
      assert.equal(r.total, 1); assert.equal(r.rows[0].external_case_id, search);
    }
    assert.equal((await loadCaseList({ search: "2000018642386506" }, db)).rows[0].external_case_id, "5587459753");
    assert.ok((await loadCaseList({ search: "1012PP.151225" }, db)).total > 0);
    const broad = await loadCaseList({ search: "Placa" }, db);
    assert.ok(broad.total > 30); assert.equal(broad.rows.length, 30);
    assert.equal(new Set(broad.rows.map(r => r.id)).size, 30);
    for (const search of ['%_)"comma,', "NO_MATCH_987654321"]) assert.equal((await loadCaseList({ search }, db)).total, 0);
    assert.equal((await loadCaseList({ page: "NaN" }, db)).page, 1);
    const localUrl = process.env.CASE_LOCAL_URL;
    if (localUrl) {
      // Use the normal signed session contract for HTTP validation, without changing users or auth.
      const user = await db.from("app_users").select("id,name,is_master,session_version").eq("active", true).limit(1).single().throwOnError();
      const token = await createSessionToken({ sub: user.data.id, name: user.data.name, isMaster: user.data.is_master, sessionVersion: user.data.session_version });
      const headers = { Cookie: `${AUTH_COOKIE_NAME}=${token}` };
      for (const suffix of ["", "?marketplace=shopee&context=return", "?search=5587459753", "?context=return&search=2610040NPM7U341", "?tab=action", `/${first.rows[0].id}`]) {
        const response: Response = await fetch(`${localUrl}/central-reclamacoes${suffix}`, { headers });
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(!html.includes("Não foi possível ler os Casos persistidos"));
        assert.ok(html.includes(suffix.startsWith("/") ? "Voltar" : "Casos registrados"));
        if (suffix.includes("search=")) assert.ok(html.includes(new URLSearchParams(suffix.slice(1)).get("search")!));
      }
    }
    const byAccount = Object.fromEntries(Object.keys(expectedAccounts).map(name => [name, all.filter(r => r.account.name === name).length]));
    const missing = Object.fromEntries(["status", "needs_action", "reason", "reason_code", "buyer_description", "official_updated_at", "product", "item"].map(field => [field, all.filter(r => r[field] == null).length]));
    const after = await db.from("marketplace_cases").select("id,updated_at").order("id").throwOnError();
    assert.deepEqual(new Map(after.data.map(r => [r.id, r.updated_at])), new Map(all.map(r => [r.id, r.updated_at])));
    console.log(JSON.stringify({ result: "PASS", total: all.length, ml: 100, shopee: 44, byAccount, uniqueCases: 144, unknownCases: 144, missing, reputationUnknown: all.filter(r => r.reputation_impact === "unknown").length, broadSearchTotal: broad.total, databaseRequests, tables: [...tables], marketplaceRequests: 0, mutations: 0, caseUpdates: 0, localHttp: Boolean(localUrl) }, null, 2));
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
