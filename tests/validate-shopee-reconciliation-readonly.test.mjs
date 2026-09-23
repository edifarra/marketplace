import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createReadonlyFetchGuard,
  maskId,
  safeError,
  validateSnapshotRows
} from "../scripts/validate-shopee-reconciliation-readonly.mjs";

const scriptPath = path.join(process.cwd(), "scripts/validate-shopee-reconciliation-readonly.mjs");
const source = fs.readFileSync(scriptPath, "utf8");

test("guard permite somente GET/HEAD e bloqueia origem não autorizada", async () => {
  const calls = [];
  const guarded = createReadonlyFetchGuard(async (input, init) => {
    calls.push({ input: String(input), method: init.method });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }, ["https://project.supabase.co", "https://partner.shopeemobile.com"]);
  await guarded("https://project.supabase.co/rest/v1/table", { method: "GET" });
  await guarded("https://partner.shopeemobile.com/api/v2/test", { method: "HEAD" });
  assert.deepEqual(calls.map(call => call.method), ["GET", "HEAD"]);
  await assert.rejects(guarded("https://project.supabase.co/rest/v1/table", { method: "POST" }), /READ_ONLY_GUARD/);
  await assert.rejects(guarded("https://example.com", { method: "GET" }), /origem não autorizada/);
});

test("call graph do script não importa módulos de persistência nem usa operações Supabase de escrita", () => {
  for (const forbiddenImport of ["marketplace-conversations", "shopee-oauth", "outgoing-activities", "marketplace-queue-worker"]) {
    assert.doesNotMatch(source, new RegExp(`from ["'][^"']*${forbiddenImport}`));
  }
  for (const forbiddenCall of ["insert", "upsert", "delete", "rpc", "refreshAccessToken", "getValidShopeeAccessToken"]) {
    assert.doesNotMatch(source, new RegExp(`\\.${forbiddenCall}\\s*\\(`));
  }
  const nonCryptoUpdates = [...source.matchAll(/\.update\s*\(/g)]
    .filter(match => !/create(?:Hash|Hmac)[\s\S]{0,120}$/.test(source.slice(Math.max(0, match.index - 120), match.index)));
  assert.equal(nonCryptoUpdates.length, 0);
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
  assert.match(source, /method:\s*["']GET["']/);
  for (const pureModule of ["lib/marketplace-message-reconciliation.ts", "lib/shopee-conversation-reconciliation.ts"]) {
    const pureSource = fs.readFileSync(path.join(process.cwd(), pureModule), "utf8");
    assert.doesNotMatch(pureSource, /supabaseAdmin|createClient|fetch\s*\(|\.from\s*\(/);
  }
});

test("snapshot valida conta, identidade, conversation_id e timestamps sem expor conteúdo", () => {
  const rows = [{
    id: "conversation-row", marketplace_account_id: "account-a", external_conversation_id: "external-a",
    last_message_at: "2026-09-22T12:00:00.000Z",
    marketplace_conversation_messages: [{ conversation_id: "conversation-row", external_message_id: "message-a",
      sent_at: "2026-09-22T12:00:00.000Z", text: null }]
  }];
  assert.deepEqual(validateSnapshotRows(rows, "account-a", ["external-a"]), { issues: [], identities: 1 });
  const invalid = validateSnapshotRows([{ ...rows[0], marketplace_account_id: "account-b" }], "account-a", ["external-a"]);
  assert.ok(invalid.issues.includes("snapshot_wrong_account"));
});

test("IDs e erros sensíveis são mascarados", () => {
  assert.match(maskId("sensitive-id"), /^sha256:[a-f0-9]{10}$/);
  const redacted = safeError("access_token=secret-value&shop_id=1 Authorization: bearer-secret");
  assert.doesNotMatch(redacted, /secret-value|bearer-secret/);
});
