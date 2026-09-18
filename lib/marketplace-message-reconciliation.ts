export type MarketplaceMessageWrite = {
  conversation_id: string;
  external_message_id: string;
  direction: string;
  message_type: string;
  text: string;
  sender_id: string | null;
  sender_name: string | null;
  sent_at: string;
  status: string;
  raw_data: Record<string, any>;
  marketplace_account_id?: string | null;
  external_message_key?: string | null;
};

export type MarketplaceMessageSnapshot = Partial<MarketplaceMessageWrite> & {
  id?: string;
  raw_content?: unknown;
  raw_source_content?: unknown;
  raw_image_url?: unknown;
  raw_url?: unknown;
  raw_message_type?: unknown;
  raw_type?: unknown;
};

export type MessageReconciliationPlan = {
  inserted: MarketplaceMessageWrite[];
  updated: MarketplaceMessageWrite[];
  unchanged: MarketplaceMessageWrite[];
};

const CONVERSATION_FIELDS = [
  "external_status", "status", "requires_response", "unread", "buyer_id", "buyer_name",
  "product_id", "listing_id", "order_id", "sku", "product_title", "product_price",
  "available_stock", "product_status", "product_image_url", "purchased_at", "last_incoming_at",
  "last_outgoing_at", "last_message_at", "last_message_preview", "last_error", "pack_id",
  "seller_id", "conversation_path", "counterparty_id", "messaging_agent", "reviewed_at"
] as const;

export const MESSAGE_SNAPSHOT_SELECT = [
  "id", "conversation_id", "external_message_id", "direction", "message_type", "text", "sender_id", "sender_name", "sent_at", "status",
  "marketplace_account_id", "external_message_key", "raw_content:raw_data->content",
  "raw_source_content:raw_data->source_content", "raw_image_url:raw_data->>image_url",
  "raw_url:raw_data->>url", "raw_message_type:raw_data->>message_type", "raw_type:raw_data->>type"
].join(",");

export function planMarketplaceMessageWrites(
  desired: MarketplaceMessageWrite[],
  existing: MarketplaceMessageSnapshot[]
): MessageReconciliationPlan {
  const existingById = new Map(existing.map(row => [String(row.external_message_id || ""), row]));
  const plan: MessageReconciliationPlan = { inserted: [], updated: [], unchanged: [] };
  for (const message of desired) {
    const current = existingById.get(message.external_message_id);
    if (!current) plan.inserted.push(message);
    else if (marketplaceMessageChanged(current, message)) plan.updated.push(message);
    else plan.unchanged.push(message);
  }
  return plan;
}

export function marketplaceMessageChanged(existing: MarketplaceMessageSnapshot, desired: MarketplaceMessageWrite) {
  return stableValue({
    conversation_id: existing.conversation_id,
    external_message_id: existing.external_message_id,
    direction: existing.direction,
    message_type: existing.message_type,
    text: existing.text,
    sender_id: existing.sender_id,
    sender_name: existing.sender_name,
    sent_at: normalizeTimestamp(existing.sent_at),
    status: existing.status,
    marketplace_account_id: existing.marketplace_account_id,
    external_message_key: existing.external_message_key,
    raw: existingRawProjection(existing)
  }) !== stableValue({
    conversation_id: desired.conversation_id,
    external_message_id: desired.external_message_id,
    direction: desired.direction,
    message_type: desired.message_type,
    text: desired.text,
    sender_id: desired.sender_id,
    sender_name: desired.sender_name,
    sent_at: normalizeTimestamp(desired.sent_at),
    status: desired.status,
    marketplace_account_id: desired.marketplace_account_id,
    external_message_key: desired.external_message_key,
    raw: relevantMessageRawData(desired.raw_data)
  });
}

export function marketplaceConversationChanged(existing: Record<string, any> | null | undefined, desired: Record<string, any>) {
  if (!existing) return true;
  const current = Object.fromEntries(CONVERSATION_FIELDS.map(field => [field, normalizeConversationValue(field, existing[field])]));
  const next = Object.fromEntries(CONVERSATION_FIELDS.map(field => [
    field,
    normalizeConversationValue(field, Object.prototype.hasOwnProperty.call(desired, field) ? desired[field] : existing[field])
  ]));
  return stableValue(current) !== stableValue(next);
}

export function relevantMessageRawData(raw: Record<string, any> | null | undefined) {
  return compactObject({
    content: raw?.content,
    source_content: raw?.source_content,
    image_url: raw?.image_url,
    url: raw?.url,
    message_type: raw?.message_type,
    type: raw?.type
  });
}

function existingRawProjection(existing: MarketplaceMessageSnapshot) {
  return compactObject({
    content: existing.raw_content,
    source_content: existing.raw_source_content,
    image_url: existing.raw_image_url,
    url: existing.raw_url,
    message_type: existing.raw_message_type,
    type: existing.raw_type
  });
}

function normalizeConversationValue(field: string, value: unknown) {
  if (["last_incoming_at", "last_outgoing_at", "last_message_at", "purchased_at", "reviewed_at"].includes(field)) {
    return normalizeTimestamp(value);
  }
  if (["requires_response", "unread", "messaging_agent"].includes(field)) return Boolean(value);
  if (["product_price", "available_stock"].includes(field)) return value == null ? null : Number(value);
  return value ?? null;
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
