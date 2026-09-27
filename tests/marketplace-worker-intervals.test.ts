import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import workerDefaults from "../scripts/marketplace-worker-defaults.json";

const root = process.cwd();

test("worker limita o backoff ocioso a 60 segundos", () => {
  assert.equal(workerDefaults.idleDelayMaxMs, 60_000);

  const ecosystem = require(path.join(root, "ecosystem.config.cjs"));
  assert.equal(ecosystem.apps[0].env.MARKETPLACE_WORKER_IDLE_MAX_MS, "60000");
});

test("safety net de conversas roda a cada 15 minutos", () => {
  assert.equal(workerDefaults.conversationSyncIntervalMs, 15 * 60_000);

  const ecosystem = require(path.join(root, "ecosystem.config.cjs"));
  assert.equal(ecosystem.apps[0].env.MARKETPLACE_CONVERSATION_RECONCILIATION_INTERVAL_MS, "900000");
});

test("webhook Shopee code 10 continua no caminho imediato de uma conversa", () => {
  const queueWorker = fs.readFileSync(path.join(root, "lib/marketplace-queue-worker.ts"), "utf8");
  const codeTenBranch = queueWorker.slice(
    queueWorker.indexOf("if (code === 10)"),
    queueWorker.indexOf("if (isShopeeVerificationPush", queueWorker.indexOf("if (code === 10)"))
  );
  assert.match(codeTenBranch, /processShopeeConversationNotification\(payload\)/);

  const conversations = fs.readFileSync(path.join(root, "lib/marketplace-conversations.ts"), "utf8");
  const immediateHandler = conversations.slice(
    conversations.indexOf("export async function processShopeeConversationNotification"),
    conversations.indexOf("export async function queueConversationReply")
  );
  assert.match(immediateHandler, /if \(conversationId\)[\s\S]*syncShopeeCandidates/);
  assert.match(immediateHandler, /loadShopeeConversationSnapshots\(account\.id, \[conversationId\]\)/);
});
