import {
  ConversationView,
  prepareConversationRows,
  rowMatchesConversationView,
  sortConversationRows
} from "./marketplace-conversation-view";
import { ConversationCursor } from "./marketplace-conversation-delta";

export const MARKETPLACE_CONVERSATION_PAGE_SIZE = 25;

export const MARKETPLACE_CONVERSATION_PAGE_SELECT = [
  "id", "marketplace", "marketplace_account_id", "external_conversation_id", "conversation_type",
  "external_status", "status", "requires_response", "unread", "buyer_id", "buyer_name",
  "product_id", "listing_id", "order_id", "sku", "product_title", "product_price",
  "available_stock", "product_image_url", "purchased_at", "last_incoming_at", "last_outgoing_at",
  "last_message_at", "last_error", "raw_data", "shopee_deleted_at", "shopee_last_message_id",
  "config_marketplace_accounts(name,nickname,shop_id)",
  "marketplace_conversation_messages(id,external_message_id,direction,message_type,text,sender_name,sent_at,status,raw_data)"
].join(",");

export type MarketplaceConversationPagePlan = {
  total: number;
  page: number;
  pageSize: number;
  conversationIds: string[];
  cursor: ConversationCursor;
};

export function normalizeMarketplaceConversationPagePlan(value: unknown): MarketplaceConversationPagePlan {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pageSize = positiveInteger(row.pageSize, MARKETPLACE_CONVERSATION_PAGE_SIZE);
  return {
    total: Math.max(0, Number(row.total) || 0),
    page: positiveInteger(row.page, 1),
    pageSize,
    conversationIds: Array.isArray(row.conversationIds) ? row.conversationIds.map(String) : [],
    cursor: normalizeCursor(row.cursor)
  };
}

// Referência executável da semântica anterior. É usada nos testes de equivalência
// entre a seleção em memória antiga e o contrato entregue pela nova RPC.
export function legacyConversationPagePlan(
  sourceRows: Array<Record<string, any>>,
  view: ConversationView,
  requestedPage: number,
  withProductHours: number,
  withoutProductHours: number,
  now: number,
  pageSize = MARKETPLACE_CONVERSATION_PAGE_SIZE
) {
  const filtered = prepareConversationRows(sourceRows, withProductHours, withoutProductHours, now)
    .filter(row => rowMatchesConversationView(row, view, now))
    .sort(sortConversationRows);
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
  return {
    total,
    page,
    pageSize,
    conversationIds: rows.flatMap(row => row.grouped_conversation_ids),
    cursor: { updatedAt: "2026-09-29T12:00:00.000Z", id: "00000000-0000-0000-0000-000000000000" },
    rows
  };
}

export function hydrateMarketplaceConversationPage(
  sourceRows: Array<Record<string, any>>,
  plan: MarketplaceConversationPagePlan,
  withProductHours: number,
  withoutProductHours: number,
  now: number
) {
  const selected = new Set(plan.conversationIds);
  return prepareConversationRows(sourceRows.filter(row => selected.has(String(row.id))), withProductHours, withoutProductHours, now)
    .sort(sortConversationRows);
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

function normalizeCursor(value: unknown): ConversationCursor {
  const cursor = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    updatedAt: String(cursor.updatedAt || "1970-01-01T00:00:00.000Z"),
    id: String(cursor.id || "00000000-0000-0000-0000-000000000000")
  };
}
