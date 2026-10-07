import { messagesWithVisibleShopeeProductCards } from "../../lib/shopee-message-product-cards";
import type { ConversationRow } from "../../lib/marketplace-conversation-view";

export function conversationProductLinks(row: ConversationRow) {
  if (row.marketplace === "shopee") {
    // Reuse the cards already resolved for this chat's account and timeline.
    const messages = [...messagesWithVisibleShopeeProductCards(row.messages)];
    const card = messages[messages.length - 1]?.shopee_item_card;
    const shopId = row.config_marketplace_accounts?.shop_id;
    return {
      productId: card?.product_id || null,
      listingUrl: card?.item_id && shopId
        ? `https://shopee.com.br/product/${encodeURIComponent(shopId)}/${encodeURIComponent(card.item_id)}`
        : null
    };
  }
  const explicitUrl = row.raw_data?.item_permalink || row.raw_data?.permalink || row.raw_data?.product_url;
  const listingUrl = explicitUrl ? String(explicitUrl)
    : row.listing_id && row.marketplace === "mercado_livre"
      ? `https://produto.mercadolivre.com.br/MLB-${String(row.listing_id).replace(/^MLB/i, "")}-_JM`
      : null;
  return { productId: row.product_id, listingUrl };
}
