import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import { telegramDayRange, telegramInsideWindow } from "../lib/telegram-schedule";

function notifications(config: Record<string, unknown>, jobError?: { code: string }) {
  const tables: string[] = [];
  const db = { from(table: string) {
    tables.push(table);
    if (table === "telegram_notification_jobs" && jobError) return { insert: async () => ({ error: jobError }) };
    assert.equal(table, "telegram_notification_config", "disabled/not-due must not touch orders, jobs or history");
    return { select: () => ({ eq: () => ({ single: async () => ({ data: config }) }) }) };
  } };
  const source = ts.transpileModule(fs.readFileSync("lib/telegram-notifications.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  new Function("require", "exports", "fetch", source)((name: string) => name === "./supabase-admin" ? { supabaseAdmin: () => db } : name === "./telegram-schedule" ? { telegramDayRange, telegramInsideWindow } : {}, exports, () => { throw new Error("Real network forbidden in tests"); });
  return { api: exports, tables };
}

test("disabled module reads only config for dispatch, new sale and manual test", async () => {
  const { api, tables } = notifications({ enabled: false });
  assert.deepEqual(await api.runPendingDispatchJob(), { skipped: "disabled" });
  await api.notifyNewSale("unused");
  await assert.rejects(api.testTelegram(), /Ative/);
  assert.equal(tables.length, 3);
});

test("dispatch option off and not-due skip orders and daily claim", async () => {
  for (const config of [
    { enabled: true, dispatch_enabled: false },
    { enabled: true, dispatch_enabled: true, timezone: "America/Sao_Paulo", dispatch_check_time: "16:30:00" }
  ]) {
    const { api } = notifications(config);
    assert.ok((await api.runPendingDispatchJob(new Date("2026-10-16T12:00:00Z"))).skipped);
  }
});

test("new sale option off and outside window skip order queries", async () => {
  for (const config of [
    { enabled: true, new_sale_enabled: false },
    { enabled: true, new_sale_enabled: true, timezone: "UTC", new_sale_start: "00:00", new_sale_end: "00:00" }
  ]) await notifications(config).api.notifyNewSale("unused");
});

test("windows include boundaries and support crossing midnight", () => {
  assert.equal(telegramInsideWindow("12:00", "11:00:00", "13:00:00"), true);
  assert.equal(telegramInsideWindow("13:00", "11:00", "13:00"), true);
  assert.equal(telegramInsideWindow("14:00", "11:00", "13:00"), false);
  assert.equal(telegramInsideWindow("00:30", "23:00", "01:00"), true);
  assert.equal(telegramInsideWindow("12:00", "23:00", "01:00"), false);
});

test("daily unique claim prevents repeated dispatch without reading orders", async () => {
  const { api, tables } = notifications({ enabled: true, dispatch_enabled: true, timezone: "UTC", dispatch_check_time: "16:30" }, { code: "23505" });
  assert.deepEqual(await api.runPendingDispatchJob(new Date("2026-10-16T18:00Z")), { skipped: "already_run" });
  assert.deepEqual(tables, ["telegram_notification_config", "telegram_notification_jobs"]);
});

test("dispatch calendar range uses configured timezone and DST", () => {
  assert.deepEqual(telegramDayRange(new Date("2026-10-16T15:00Z"), "America/Sao_Paulo"), { start: "2026-10-16T03:00:00.000Z", end: "2026-10-17T03:00:00.000Z" });
  assert.deepEqual(telegramDayRange(new Date("2026-03-08T15:00Z"), "America/New_York"), { start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z" });
});
