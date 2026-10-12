type Row = Record<string, any>;

// Sale identity is mandatory: a SKU alone never identifies a seller's listing.
export function returnProductLinks(row: Row, item: Row) {
  let productId = item.scope === "case" && row.product?.id && row.product.id === item.product?.id
    ? row.product.id : null;
  const sale = row.sale;
  const unavailable = { productId, listingUrl: null as string | null };
  if (!sale || !row.order_id || sale.order_id !== row.order_id || sale.marketplace !== row.marketplace
    || !row.marketplace_account_id || sale.raw_data?.marketplace_account_id !== row.marketplace_account_id
    || !item.id || !sale.items?.some((i: Row) => i.id === item.id)) return unavailable;
  const payload = sale.raw_data?.payload || {};
  // The existing catalog lookup uses the exact canonical sale SKU, never fuzzy matching.
  if (item.product?.id && item.product.sku === item.sku) productId ||= item.product.id;
  unavailable.productId = productId;
  const order = payload.order || payload;
  const shopee = row.marketplace === "shopee";
  if (String(shopee ? order.order_sn || order.ordersn || "" : order.id || "") !== row.order_id) return unavailable;
  const entries = shopee ? order.item_list : order.order_items;
  if (!Array.isArray(entries) || !item.sku) return unavailable;
  const matches = entries.filter((entry: Row) => String(shopee
    ? entry.model_sku || entry.item_sku || entry.sku || ""
    : entry.item?.seller_sku || entry.item?.seller_custom_field || entry.seller_sku || "") === item.sku);
  const ids = [...new Set(matches.map((entry: Row) => String(shopee ? entry.item_id || "" : entry.item?.id || "")))];
  if (ids.length !== 1) return unavailable;
  const listing = ids[0];
  if (shopee) {
    const shop = String(row.account?.shop_id || row.account?.account_id || "");
    if (!/^\d+$/.test(shop) || !/^\d+$/.test(listing)) return unavailable;
    const originalShop = payload.notification?.shop_id || order.shop_id;
    if (originalShop && String(originalShop) !== shop) return unavailable;
    return { productId, listingUrl: `https://shopee.com.br/product/${shop}/${listing}` };
  }
  if (row.marketplace !== "mercado_livre" || !/^MLB\d+$/.test(listing)) return unavailable;
  const seller = row.account?.seller_id || row.account?.account_id;
  if (!seller || String(order.seller?.id || "") !== String(seller)) return unavailable;
  return { productId, listingUrl: `https://produto.mercadolivre.com.br/MLB-${listing.slice(3)}-_JM` };
}
