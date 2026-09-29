import assert from "node:assert/strict";
import test from "node:test";
import {
  GlobalMarketplaceNotificationPoller,
  MarketplaceNotificationPage,
  initialMarketplaceNotificationCursor,
  mergeMarketplaceNotifications,
  notificationPollDelay
} from "../lib/global-marketplace-notifications";

const baseCursor = initialMarketplaceNotificationCursor("2026-09-29T12:00:12.000Z");
const emptyPage = (at = "2026-09-29T12:00:12.000Z"): MarketplaceNotificationPage => ({
  cursor: initialMarketplaceNotificationCursor(at), notifications: [], hasMore: false, until: at
});

function harness(pages: Array<MarketplaceNotificationPage | Error>, initialVisibility = "visible") {
  let visibility = initialVisibility;
  const calls: Array<{ cursor: unknown; until?: string }> = [];
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  const received: string[] = [];
  const poller = new GlobalMarketplaceNotificationPoller({
    visibility: () => visibility,
    fetchPage: async (cursor, until) => {
      calls.push({ cursor, until });
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return page || emptyPage();
    },
    onNotifications: notifications => received.push(...notifications.map(item => item.id)),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: timer => { (timer as unknown as typeof timers[number]).cleared = true; }
  });
  return { poller, calls, timers, received, setVisibility: (value: string) => { visibility = value; } };
}

test("polling normal estabelece baseline e agenda o intervalo rápido", async () => {
  const value = harness([emptyPage()]);
  await value.poller.start();
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0].cursor, null);
  assert.equal(value.timers.at(-1)?.delay, 12_000);
  value.poller.stop();
});

test("polling vazio aplica backoff limitado sem abandonar o cursor", async () => {
  const value = harness([emptyPage(), emptyPage("2026-09-29T12:00:24.000Z")]);
  await value.poller.start();
  await value.poller.poll();
  assert.deepEqual(value.calls[1].cursor, baseCursor);
  assert.equal(value.timers.at(-1)?.delay, notificationPollDelay(1));
  value.poller.stop();
});

test("aba oculta suspende timer e não consulta periodicamente", async () => {
  const value = harness([emptyPage()]);
  await value.poller.start();
  value.setVisibility("hidden");
  await value.poller.visibilityChanged();
  await value.poller.poll();
  assert.equal(value.calls.length, 1);
  assert.equal(value.timers[0].cleared, true);
  value.poller.stop();
});

test("retorno à aba recupera imediatamente desde o cursor preservado", async () => {
  const value = harness([emptyPage(), emptyPage("2026-09-29T13:00:00.000Z")], "hidden");
  await value.poller.start();
  value.setVisibility("visible");
  await value.poller.visibilityChanged();
  assert.equal(value.calls.length, 2);
  assert.deepEqual(value.calls[1].cursor, baseCursor);
  value.poller.stop();
});

test("venda e mensagem novas são entregues e o cursor avança", async () => {
  const activityPage: MarketplaceNotificationPage = {
    cursor: initialMarketplaceNotificationCursor("2026-09-29T12:01:00.000Z"),
    until: "2026-09-29T12:01:00.000Z", hasMore: false,
    notifications: [
      { id: "sale:1", kind: "sale", marketplace: "shopee", title: "Venda", description: "SKU", occurredAt: "2026-09-29T12:00:30.000Z", href: "/vendas" },
      { id: "message:1", kind: "message", marketplace: "mercado_livre", title: "Mensagem", description: "Olá", occurredAt: "2026-09-29T12:00:40.000Z", href: "/chats-perguntas" }
    ]
  };
  const value = harness([emptyPage(), activityPage]);
  await value.poller.start();
  await value.poller.poll();
  assert.deepEqual(value.received, ["sale:1", "message:1"]);
  assert.deepEqual(value.poller.currentCursor(), activityPage.cursor);
  assert.equal(value.timers.at(-1)?.delay, 12_000);
  value.poller.stop();
});

test("erro temporário preserva cursor e agenda nova tentativa rápida", async () => {
  const value = harness([emptyPage(), new Error("temporário"), emptyPage("2026-09-29T12:01:00.000Z")]);
  await value.poller.start();
  await value.poller.poll();
  assert.deepEqual(value.poller.currentCursor(), baseCursor);
  assert.equal(value.timers.at(-1)?.delay, 12_000);
  await value.poller.poll();
  assert.deepEqual(value.calls[2].cursor, baseCursor);
  value.poller.stop();
});

test("requisições sobrepostas reutilizam o mesmo trabalho em andamento", async () => {
  let release!: (page: MarketplaceNotificationPage) => void;
  const pending = new Promise<MarketplaceNotificationPage>(resolve => { release = resolve; });
  let calls = 0;
  const poller = new GlobalMarketplaceNotificationPoller({
    visibility: () => "visible",
    fetchPage: async () => { calls += 1; return pending; },
    onNotifications: () => undefined
  });
  const first = poller.start();
  const second = poller.poll();
  assert.equal(calls, 1);
  release(emptyPage());
  await Promise.all([first, second]);
  poller.stop();
});

test("paginação mantém o mesmo teto e não descarta notificações", async () => {
  const first: MarketplaceNotificationPage = {
    ...emptyPage(),
    notifications: [{ id: "sale:1", kind: "sale", marketplace: "shopee", title: "Venda", description: "A", occurredAt: "2026-09-29T12:00:10.000Z", href: "/vendas" }],
    hasMore: true
  };
  const second: MarketplaceNotificationPage = {
    ...emptyPage(),
    notifications: [{ id: "message:1", kind: "message", marketplace: "shopee", title: "Mensagem", description: "B", occurredAt: "2026-09-29T12:00:11.000Z", href: "/chats-perguntas" }]
  };
  const value = harness([first, second]);
  await value.poller.start();
  assert.deepEqual(value.received, ["sale:1", "message:1"]);
  assert.equal(value.calls[1].until, first.until);
  value.poller.stop();
});

test("merge deduplica sem limitar a fila pendente", () => {
  const notification = (id: string, occurredAt: string) => ({ id, kind: "sale" as const, marketplace: "shopee" as const, title: id, description: id, occurredAt, href: "/vendas" });
  const merged = mergeMarketplaceNotifications(
    [notification("sale:1", "2026-09-29T12:00:00.000Z")],
    [notification("sale:1", "2026-09-29T12:00:00.000Z"), notification("sale:2", "2026-09-29T12:01:00.000Z")]
  );
  assert.deepEqual(merged.map(item => item.id), ["sale:2", "sale:1"]);
});
