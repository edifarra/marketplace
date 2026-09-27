import { loadUniqueValuesInChunks, shopeeProductEnrichment, SHOPEE_PRODUCT_LOOKUP_SELECT } from "./shopee-conversation-reconciliation";

export type ShopeeMessageProductCard = {
  item_id: string;
  found: boolean;
  product_id?: string | null;
  sku?: string | null;
  title?: string | null;
  price?: number | null;
  stock?: number | null;
  status?: string | null;
  image_url?: string | null;
  permalink?: string | null;
};

export function messagesWithVisibleShopeeProductCards(messages: Array<Record<string, any>>) {
  const visible = new Set<Record<string, any>>();
  let lastExplicitIncomingItemId = "";

  for (const message of messages) {
    if (message.direction !== "incoming") continue;
    const itemId = String(message.shopee_item_card?.item_id || "").trim();
    if (!itemId) continue;
    if (itemId !== lastExplicitIncomingItemId) visible.add(message);
    lastExplicitIncomingItemId = itemId;
  }

  return visible;
}

export function explicitShopeeMessageItemId(raw: Record<string, any> | null | undefined) {
  if (!raw) return "";
  const sourceItemId = raw.source_content?.item_id;
  if (sourceItemId != null && String(sourceItemId).trim()) return String(sourceItemId).trim();
  const type = String(raw.message_type || raw.type || "").toLowerCase();
  const contentItemId = type === "item" ? raw.content?.item_id : null;
  if (contentItemId != null && String(contentItemId).trim()) return String(contentItemId).trim();
  // Caminho histórico já aceito em mensagens normalizadas.
  if (raw.item_id != null && String(raw.item_id).trim()) return String(raw.item_id).trim();
  return "";
}

export function shopeeMessageProductCard(itemId: string, row?: Record<string, any>): ShopeeMessageProductCard {
  if (!row) return { item_id: itemId, found: false };
  const product = shopeeProductEnrichment(row);
  return {
    item_id: itemId,
    found: true,
    product_id: product.product_id || null,
    sku: product.sku || null,
    title: product.product_title || null,
    price: product.product_price ?? null,
    stock: product.available_stock ?? null,
    status: product.product_status || null,
    image_url: product.product_image_url || null,
    permalink: product.item_permalink || null
  };
}

export function attachShopeeMessageProductCards(
  conversations: Array<Record<string, any>>,
  productsByAccountAndItem: Map<string, Record<string, any>>
) {
  return conversations.map(conversation => {
    if (conversation.marketplace !== "shopee") return conversation;
    const accountId = String(conversation.marketplace_account_id || "");
    const sourceMessages = conversation.marketplace_conversation_messages || conversation.messages || [];
    const messages = sourceMessages.map((message: Record<string, any>) => {
      const itemId = explicitShopeeMessageItemId(message.raw_data);
      if (!itemId) return message;
      return { ...message, shopee_item_card: shopeeMessageProductCard(itemId, productsByAccountAndItem.get(`${accountId}:${itemId}`)) };
    });
    return conversation.marketplace_conversation_messages
      ? { ...conversation, marketplace_conversation_messages: messages }
      : { ...conversation, messages };
  });
}

export async function enrichShopeeMessageProductCards(db: any, conversations: Array<Record<string, any>>) {
  const references = new Map<string, Set<string>>();
  for (const conversation of conversations) {
    if (conversation.marketplace !== "shopee") continue;
    const accountId = String(conversation.marketplace_account_id || "");
    if (!accountId) continue;
    for (const message of conversation.marketplace_conversation_messages || conversation.messages || []) {
      const itemId = explicitShopeeMessageItemId(message.raw_data);
      if (itemId) references.set(accountId, new Set([...(references.get(accountId) || []), itemId]));
    }
  }
  const products = new Map<string, Record<string, any>>();
  for (const [accountId, itemIds] of references) {
    const rows = await loadUniqueValuesInChunks<Record<string, any>>([...itemIds], async ids => {
      const result = await db.from("product_marketplaces").select(SHOPEE_PRODUCT_LOOKUP_SELECT)
        .eq("marketplace", "shopee").eq("marketplace_account_id", accountId)
        .in("marketplace_product_id", ids).throwOnError();
      return (result.data || []) as Array<Record<string, any>>;
    });
    for (const row of rows) products.set(`${accountId}:${row.marketplace_product_id}`, row);
  }
  return attachShopeeMessageProductCards(conversations, products);
}
