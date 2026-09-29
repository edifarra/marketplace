import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { enqueueMarketplaceActivityWithClient } from "../lib/marketplace-queue";

type Row = { id: string; status: string; processing_error: string | null; processed_at: string | null };

function atomicRpc() {
  const rows = new Map<string, Row>();
  const calls: Array<{ name: string; params: Record<string, any> }> = [];
  let nextError: Error | null = null;
  let sequence = 0;
  const client = {
    rpc(name: string, params: Record<string, any>) {
      calls.push({ name, params });
      return {
        single() { return this; },
        async throwOnError() {
          if (nextError) {
            const error = nextError;
            nextError = null;
            throw error;
          }
          const key = `${params.p_marketplace}:${params.p_external_event_id}`;
          const existing = rows.get(key);
          if (existing) {
            const previousStatus = existing.status;
            if (["error", "retry"].includes(existing.status) && params.p_status === "queued") {
              existing.status = "queued";
              existing.processing_error = null;
              existing.processed_at = null;
            }
            return { data: { id: existing.id, status: previousStatus, duplicated: true }, error: null };
          }
          const row = { id: `activity-${++sequence}`, status: params.p_status, processing_error: params.p_processing_error, processed_at: params.p_processed_at };
          rows.set(key, row);
          return { data: { id: row.id, status: row.status, duplicated: false }, error: null };
        }
      };
    }
  };
  return { client, rows, calls, failWith(error: Error) { nextError = error; } };
}

function input(marketplace: "mercado_livre" | "shopee", externalEventId: string) {
  return { marketplace, payload: { _id: externalEventId, msg_id: externalEventId }, eventType: "orders", externalEventId, description: "Evento" };
}

function historyRecorder() {
  const entries: Array<{ activityId: string; stage: string; status: string }> = [];
  return { entries, record: async (activityId: string, stage: string, status: string) => { entries.push({ activityId, stage, status }); } };
}

test("primeiro evento Mercado Livre cria atividade e registra received", async () => {
  const db = atomicRpc();
  const history = historyRecorder();
  const result = await enqueueMarketplaceActivityWithClient(db.client as never, input("mercado_livre", "ml-1"), history.record);
  assert.deepEqual(result, { id: "activity-1", duplicated: false, status: "queued" });
  assert.deepEqual(history.entries.map(entry => entry.stage), ["received"]);
  assert.equal(db.calls[0].name, "enqueue_marketplace_activity_idempotently");
});

test("redelivery identico Shopee reutiliza atividade e registra redelivery", async () => {
  const db = atomicRpc();
  const history = historyRecorder();
  const first = await enqueueMarketplaceActivityWithClient(db.client as never, input("shopee", "shopee-1"), history.record);
  const duplicate = await enqueueMarketplaceActivityWithClient(db.client as never, input("shopee", "shopee-1"), history.record);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicated, true);
  assert.equal(db.rows.size, 1);
  assert.deepEqual(history.entries.map(entry => entry.stage), ["received", "redelivery"]);
});

test("duas entregas concorrentes criam uma unica atividade", async () => {
  const db = atomicRpc();
  const history = historyRecorder();
  const [first, second] = await Promise.all([
    enqueueMarketplaceActivityWithClient(db.client as never, input("mercado_livre", "concurrent-1"), history.record),
    enqueueMarketplaceActivityWithClient(db.client as never, input("mercado_livre", "concurrent-1"), history.record)
  ]);
  assert.equal(first.id, second.id);
  assert.equal([first, second].filter(result => result.duplicated).length, 1);
  assert.equal(db.rows.size, 1);
});

test("redelivery de atividade concluida nao altera seu estado", async () => {
  const db = atomicRpc();
  const history = historyRecorder();
  await enqueueMarketplaceActivityWithClient(db.client as never, input("mercado_livre", "processed-1"), history.record);
  db.rows.get("mercado_livre:processed-1")!.status = "processed";
  const duplicate = await enqueueMarketplaceActivityWithClient(db.client as never, input("mercado_livre", "processed-1"), history.record);
  assert.equal(duplicate.status, "processed");
  assert.equal(db.rows.get("mercado_livre:processed-1")!.status, "processed");
});

for (const previousStatus of ["error", "retry"] as const) {
  test(`redelivery reativa atividade em ${previousStatus}`, async () => {
    const db = atomicRpc();
    const history = historyRecorder();
    await enqueueMarketplaceActivityWithClient(db.client as never, { ...input("mercado_livre", `${previousStatus}-1`), status: "error", processingError: "falha" }, history.record);
    const row = db.rows.get(`mercado_livre:${previousStatus}-1`)!;
    row.status = previousStatus;
    const duplicate = await enqueueMarketplaceActivityWithClient(db.client as never, input("mercado_livre", `${previousStatus}-1`), history.record);
    assert.equal(duplicate.status, previousStatus);
    assert.equal(row.status, "queued");
    assert.equal(row.processing_error, null);
    assert.equal(row.processed_at, null);
  });
}

test("erro real da RPC continua sendo propagado", async () => {
  const db = atomicRpc();
  db.failWith(new Error("database unavailable"));
  await assert.rejects(
    enqueueMarketplaceActivityWithClient(db.client as never, input("shopee", "db-error"), historyRecorder().record),
    /database unavailable/
  );
});

test("migration usa conflito atomico no indice parcial e restringe a RPC", () => {
  const migrations = path.join(process.cwd(), "supabase", "migrations");
  const filename = fs.readdirSync(migrations).find(name => name.endsWith("_enqueue_marketplace_activity_idempotently.sql"));
  assert.ok(filename);
  const sql = fs.readFileSync(path.join(migrations, filename), "utf8");
  assert.match(sql, /on conflict \(marketplace, external_event_id\)\s+where external_event_id is not null\s+do nothing/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /existing_activity\.status in \('error', 'retry'\)/i);
  assert.match(sql, /revoke execute[\s\S]+from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]+to service_role/i);
  assert.doesNotMatch(sql, /drop\s+index|drop\s+constraint/i);
});
