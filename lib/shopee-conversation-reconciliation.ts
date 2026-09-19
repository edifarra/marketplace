import { MESSAGE_SNAPSHOT_SELECT } from "./marketplace-message-reconciliation";

export const SHOPEE_CONVERSATION_SNAPSHOT_FIELDS = [
  "id", "marketplace_account_id", "external_conversation_id", "external_status", "status",
  "requires_response", "unread", "buyer_id", "buyer_name", "product_id", "listing_id",
  "order_id", "sku", "product_title", "product_price", "available_stock", "product_status",
  "product_image_url", "purchased_at", "last_incoming_at", "last_outgoing_at", "last_message_at",
  "last_message_preview", "last_error", "pack_id", "seller_id", "conversation_path",
  "counterparty_id", "messaging_agent", "reviewed_at"
] as const;

export const SHOPEE_CONVERSATION_SNAPSHOT_SELECT =
  `${SHOPEE_CONVERSATION_SNAPSHOT_FIELDS.join(",")},marketplace_conversation_messages(${MESSAGE_SNAPSHOT_SELECT})`;

export const SHOPEE_PRODUCT_LOOKUP_SELECT =
  "marketplace_product_id,product_id,sku,titulo_marketplace,valor_marketplace,estoque_marketplace,status_anuncio,raw_data,products(title,price,estoque(estoque_disponivel))";

export function shopeeSnapshotKey(accountId: string, externalConversationId: string) {
  return `${accountId}:${externalConversationId}`;
}

export function mapShopeeConversationSnapshots(rows: Array<Record<string, any>>) {
  return new Map(rows.map(row => [
    shopeeSnapshotKey(String(row.marketplace_account_id || ""), String(row.external_conversation_id || "")),
    row
  ]));
}

export function uniqueShopeeCandidates<T extends { id: string }>(candidates: T[]) {
  const seen = new Set<string>();
  return candidates.filter(candidate => Boolean(candidate.id) && !seen.has(candidate.id) && Boolean(seen.add(candidate.id)));
}

export function shopeeProductLookupNeeded(existing: Record<string, any> | null | undefined, itemId: string) {
  if (!itemId) return false;
  return !existing
    || String(existing.listing_id || "") !== itemId
    || !existing.product_id;
}

export function shopeeProductEnrichment(row: Record<string, any> | null | undefined) {
  if (!row) return {};
  const stock = Array.isArray(row.products?.estoque) ? row.products.estoque[0] : row.products?.estoque;
  return {
    product_id: row.product_id,
    sku: row.sku,
    product_title: row.titulo_marketplace || row.products?.title,
    product_price: row.valor_marketplace || row.products?.price,
    available_stock: stock?.estoque_disponivel ?? row.estoque_marketplace,
    product_status: row.status_anuncio,
    product_image_url: row.raw_data?.image?.image_url_list?.[0]
      || row.raw_data?.promotion_image?.image_url_list?.[0]
      || row.raw_data?.thumbnail
      || null,
    item_permalink: row.raw_data?.permalink || null
  };
}
