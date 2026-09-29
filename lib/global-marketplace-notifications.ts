export type MarketplaceNotification = {
  id: string;
  kind: "sale" | "message";
  marketplace: "mercado_livre" | "shopee";
  title: string;
  customer?: string;
  description: string;
  occurredAt: string;
  href: string;
};

export type NotificationCursorPosition = { createdAt: string; id: string };
export type MarketplaceNotificationCursor = {
  sales: NotificationCursorPosition;
  messages: NotificationCursorPosition;
};

export type MarketplaceNotificationPage = {
  cursor: MarketplaceNotificationCursor;
  notifications: MarketplaceNotification[];
  hasMore: boolean;
  until: string;
};

export const NOTIFICATION_FAST_POLL_MS = 12_000;
export const NOTIFICATION_MAX_IDLE_POLL_MS = 60_000;

export function notificationPollDelay(emptyPolls: number) {
  if (emptyPolls <= 0) return NOTIFICATION_FAST_POLL_MS;
  return Math.min(NOTIFICATION_MAX_IDLE_POLL_MS, NOTIFICATION_FAST_POLL_MS * (2 ** emptyPolls));
}

export function notificationCursorQuery(cursor: MarketplaceNotificationCursor | null, until?: string) {
  if (!cursor) return "";
  const params = new URLSearchParams({ cursor: JSON.stringify(cursor) });
  if (until) params.set("until", until);
  return `?${params.toString()}`;
}

export function mergeMarketplaceNotifications(current: MarketplaceNotification[], incoming: MarketplaceNotification[]) {
  const merged = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) =>
    new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

type PollerOptions = {
  visibility: () => string;
  fetchPage: (cursor: MarketplaceNotificationCursor | null, until?: string) => Promise<MarketplaceNotificationPage>;
  onNotifications: (notifications: MarketplaceNotification[]) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class GlobalMarketplaceNotificationPoller {
  private cursor: MarketplaceNotificationCursor | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private emptyPolls = 0;
  private readonly setTimer: NonNullable<PollerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<PollerOptions["clearTimer"]>;

  constructor(private readonly options: PollerOptions) {
    this.setTimer = options.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer || (timer => clearTimeout(timer));
  }

  start() {
    this.stopped = false;
    return this.poll(true);
  }

  stop() {
    this.stopped = true;
    this.cancelTimer();
  }

  visibilityChanged() {
    if (this.options.visibility() !== "visible") {
      this.cancelTimer();
      return Promise.resolve();
    }
    return this.poll();
  }

  poll(forceBaseline = false) {
    if (this.stopped || this.inFlight) return this.inFlight || Promise.resolve();
    if (!forceBaseline && this.options.visibility() !== "visible") return Promise.resolve();
    this.cancelTimer();
    this.inFlight = this.runPoll().finally(() => {
      this.inFlight = null;
      this.schedule();
    });
    return this.inFlight;
  }

  currentCursor() {
    return this.cursor;
  }

  private async runPoll() {
    const baseline = this.cursor === null;
    let until: string | undefined;
    let received = 0;
    try {
      do {
        const page = await this.options.fetchPage(this.cursor, until);
        this.cursor = page.cursor;
        until = page.until;
        if (page.notifications.length) {
          received += page.notifications.length;
          this.options.onNotifications(page.notifications);
        }
        if (!page.hasMore) break;
      } while (!this.stopped);
      this.emptyPolls = baseline || received > 0 ? 0 : this.emptyPolls + 1;
    } catch {
      // Uma falha temporária mantém o cursor e volta a tentar no intervalo rápido.
      this.emptyPolls = 0;
    }
  }

  private schedule() {
    if (this.stopped || this.options.visibility() !== "visible") return;
    this.timer = this.setTimer(() => { void this.poll(); }, notificationPollDelay(this.emptyPolls));
  }

  private cancelTimer() {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

export function initialMarketplaceNotificationCursor(checkedAt: string): MarketplaceNotificationCursor {
  return {
    sales: { createdAt: checkedAt, id: "" },
    messages: { createdAt: checkedAt, id: "" }
  };
}

export function parseMarketplaceNotificationCursor(value: string | null): MarketplaceNotificationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as MarketplaceNotificationCursor;
    return validPosition(parsed?.sales) && validPosition(parsed?.messages) ? parsed : null;
  } catch {
    return null;
  }
}

function validPosition(position: NotificationCursorPosition | undefined) {
  return Boolean(position && validTimestamp(position.createdAt) && (!position.id || validUuid(position.id)));
}

export function validTimestamp(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(new Date(value).getTime());
}

export function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
