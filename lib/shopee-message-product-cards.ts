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
  shop_id?: string;
  buyer_context?: boolean;
};

export function messagesWithVisibleShopeeProductCards(messages: Array<Record<string, any>>) {
  const visible = new Set<Record<string, any>>();
  let lastExplicitIncomingItemId = "";

  for (const message of messages) {
    if (message.direction !== "incoming" && !message.shopee_item_card?.buyer_context) continue;
    const itemId = String(message.shopee_item_card?.item_id || "").trim();
    if (!itemId) continue;
    if (itemId !== lastExplicitIncomingItemId) visible.add(message);
    lastExplicitIncomingItemId = itemId;
  }

  return visible;
}

// In a seller's chat, their account can also be the buyer of the peer shop's item.
// Only explicit peer-owned item cards or mall product inquiries prove this case.
export function outgoingShopeeBuyerContextShopId(message: Record<string, any>) {
  if (message.direction !== "outgoing") return "";
  const raw = message.raw_data;
  if (!explicitShopeeMessageItemId(raw)) return "";
  const peerShop = String(raw?.to_shop_id || "");
  const senderShop = String(raw?.from_shop_id || "");
  if (!peerShop || !senderShop || peerShop === senderShop) return "";
  const itemOwner = String(raw?.content?.shop_id || "");
  const isPeerItem = raw?.message_type === "item" && itemOwner === peerShop;
  const isMallInquiry = raw?.message_type === "text" && raw?.source === "pc_mall_minichat";
  return isPeerItem || isMallInquiry ? peerShop : "";
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
  productsByAccountAndItem: Map<string, Record<string, any>>,
  accountsByShop: Map<string, string> = new Map()
) {
  return conversations.map(conversation => {
    if (conversation.marketplace !== "shopee") return conversation;
    const accountId = String(conversation.marketplace_account_id || "");
    const sourceMessages = conversation.marketplace_conversation_messages || conversation.messages || [];
    const messages = sourceMessages.map((message: Record<string, any>) => {
      const itemId = explicitShopeeMessageItemId(message.raw_data);
      if (!itemId) return message;
      const peerShop = outgoingShopeeBuyerContextShopId(message);
      if (peerShop) {
        const ownerAccount = accountsByShop.get(peerShop);
        return { ...message, shopee_item_card: {
          ...shopeeMessageProductCard(itemId, ownerAccount ? productsByAccountAndItem.get(`${ownerAccount}:${itemId}`) : undefined),
          shop_id: peerShop, buyer_context: true
        } };
      }
      return { ...message, shopee_item_card: shopeeMessageProductCard(itemId, productsByAccountAndItem.get(`${accountId}:${itemId}`)) };
    });
    return conversation.marketplace_conversation_messages
      ? { ...conversation, marketplace_conversation_messages: messages }
      : { ...conversation, messages };
  });
}

export async function enrichShopeeMessageProductCards(db: any, conversations: Array<Record<string, any>>) {
  const peerShops = new Set<string>();
  for (const conversation of conversations) {
    if (conversation.marketplace !== "shopee") continue;
    for (const message of conversation.marketplace_conversation_messages || conversation.messages || []) {
      const shopId = outgoingShopeeBuyerContextShopId(message);
      if (shopId) peerShops.add(shopId);
    }
  }
  const accountsByShop = new Map<string, string>();
  if (peerShops.size) {
    const accounts = await loadUniqueValuesInChunks<Record<string, any>>([...peerShops], async ids => {
      const result = await db.from("config_marketplace_accounts").select("id,shop_id")
        .eq("marketplace", "shopee").in("shop_id", ids).throwOnError();
      return result.data || [];
    });
    for (const account of accounts) accountsByShop.set(String(account.shop_id), String(account.id));
  }
  const references = new Map<string, Set<string>>();
  for (const conversation of conversations) {
    if (conversation.marketplace !== "shopee") continue;
    const accountId = String(conversation.marketplace_account_id || "");
    if (!accountId) continue;
    for (const message of conversation.marketplace_conversation_messages || conversation.messages || []) {
      const itemId = explicitShopeeMessageItemId(message.raw_data);
      const peerShop = outgoingShopeeBuyerContextShopId(message);
      const ownerAccount = peerShop ? accountsByShop.get(peerShop) : accountId;
      if (itemId && ownerAccount) references.set(ownerAccount, new Set([...(references.get(ownerAccount) || []), itemId]));
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
  return attachShopeeMessageProductCards(conversations, products, accountsByShop);
}
