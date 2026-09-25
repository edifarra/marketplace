export type MarketplaceAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  tag: string;
  isImage: boolean;
};

export function mercadoLivreAttachments(raw: Record<string, any> | null | undefined): MarketplaceAttachment[] {
  if (!Array.isArray(raw?.message_attachments)) return [];
  return raw.message_attachments.flatMap((attachment: Record<string, any>) => {
    const id = String(attachment.filename || attachment.id || "").trim();
    if (!id) return [];
    const mimeType = String(attachment.type || attachment.mime_type || "application/octet-stream").trim();
    return [{
      id,
      name: String(attachment.original_filename || attachment.filename || "Anexo"),
      mimeType,
      size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
      tag: String(attachment.tag || "post_sale"),
      isImage: mimeType.toLowerCase().startsWith("image/")
    }];
  });
}

export function marketplaceMessageType(raw: Record<string, any>, fallback = "text") {
  const attachments = mercadoLivreAttachments(raw);
  if (attachments.some(attachment => attachment.isImage)) return "image";
  if (attachments.length) return "file";
  return String(raw.message_type || raw.type || fallback || "text");
}

export function shopeeMessageText(raw: Record<string, any> | null | undefined) {
  const value = raw?.text ?? raw?.content?.text ?? raw?.message ?? "";
  return typeof value === "string" ? value : "";
}

export function shopeeMessageImageUrl(raw: Record<string, any> | null | undefined) {
  const value = raw?.content?.image_url || raw?.content?.url || raw?.image_url || raw?.url || raw?.content?.image?.url;
  return typeof value === "string" ? value : "";
}

export function isShopeeOutOfStockReminder(raw: Record<string, any> | null | undefined) {
  return String(raw?.message_type || raw?.type || "").toLowerCase() === "out_of_stock_reminder_card"
    && String(raw?.source || "").toLowerCase() === "server"
    && Boolean(raw?.content?.seller_user_id && raw?.content?.product_info?.item_id);
}

export function shopeeMessageDirection(raw: Record<string, any>, sellerMessage: boolean): "incoming" | "outgoing" | "system" {
  if (isShopeeOutOfStockReminder(raw)) return "system";
  return sellerMessage ? "outgoing" : "incoming";
}

export function shopeeConversationActivity(
  messages: Array<Record<string, any>>,
  isSellerMessage: (message: Record<string, any>) => boolean
) {
  const actionable = messages.filter(message => !isShopeeOutOfStockReminder(message));
  const latest = actionable.at(-1) || null;
  const latestIncoming = [...actionable].reverse().find(message => shopeeMessageDirection(message, isSellerMessage(message)) === "incoming") || null;
  const latestOutgoing = [...actionable].reverse().find(message => shopeeMessageDirection(message, isSellerMessage(message)) === "outgoing") || null;
  const direction = latest ? shopeeMessageDirection(latest, isSellerMessage(latest)) : null;
  return {
    latest,
    latestIncoming,
    latestOutgoing,
    direction,
    requiresResponse: direction === "incoming",
    unread: direction === "incoming"
  };
}

export function shopeeOutOfStockReminderContent(raw: Record<string, any> | null | undefined) {
  if (!isShopeeOutOfStockReminder(raw)) return null;
  const product = raw?.content?.product_info;
  const stocks = Array.isArray(product?.models)
    ? product.models.map((model: Record<string, any>) => Number(model.model_stock)).filter(Number.isFinite)
    : [];
  return {
    title: "Lembrete da Shopee",
    description: "Seu produto pode estar sem estoque, por favor atualize o estoque caso necessário.",
    productName: typeof product?.name === "string" ? product.name : "",
    itemId: product?.item_id == null ? "" : String(product.item_id),
    stock: stocks.length ? stocks.reduce((total: number, value: number) => total + value, 0) : null
  };
}

export function shopeeConversationReferences(
  messages: Array<Record<string, any>>,
  detail: Record<string, any> = {},
  seed: Record<string, any> = {}
) {
  let itemId = String(detail.item_id || seed.latest_message_content?.item_id || "");
  let orderSn = String(detail.order_sn || seed.latest_message_content?.order_sn || "");
  for (let index = messages.length - 1; index >= 0 && (!itemId || !orderSn); index -= 1) {
    const message = messages[index];
    if (!itemId) itemId = String(message.content?.item_id || message.source_content?.item_id || message.item_id || "");
    if (!orderSn) orderSn = String(message.content?.order_sn || message.source_content?.order_sn || message.order_sn || "");
  }
  return { itemId, orderSn };
}

export async function resolveMercadoLivrePackOrder(
  packId: string,
  loadRemotePack: () => Promise<Record<string, any>>,
  findLocalOrder: (candidateOrderIds: string[]) => Promise<string | null>,
  observeError: (error: unknown) => void = () => undefined
) {
  let remoteOrderIds: string[] = [];
  try {
    const pack = await loadRemotePack();
    remoteOrderIds = (Array.isArray(pack.orders) ? pack.orders : [])
      .map((item: any) => String(item.id || item.order_id || "")).filter(Boolean);
    if (!remoteOrderIds.length) observeError(new Error(`Pack ${packId} não retornou pedidos; usando fallback local.`));
  } catch (error) {
    observeError(error);
  }
  const candidates = [...new Set([packId, ...remoteOrderIds].filter(Boolean))];
  return await findLocalOrder(candidates) || remoteOrderIds[0] || null;
}

export function mapLocalOrderProducts(sales: Array<Record<string, any>>, products: Array<Record<string, any>>) {
  const productsBySku = new Map(products.map(product => [String(product.sku || ""), product]));
  return new Map<string, Record<string, any>>(sales.flatMap(sale => {
    const item = sale.venda_item?.[0];
    if (!item) return [];
    const product: any = productsBySku.get(String(item.sku || ""));
    const stock = Array.isArray(product?.estoque) ? product.estoque[0] : product?.estoque;
    const listingId = String(item.raw_data?.item?.id || item.raw_data?.item_id || item.raw_data?.order?.item_list?.[0]?.item_id || "") || null;
    return [[String(sale.order_id), {
      order_id: String(sale.order_id), listing_id: listingId, purchased_at: sale.data_venda,
      product_id: product?.id, sku: item.sku, product_title: product?.title,
      product_price: item.valor_unitario || product?.price, available_stock: stock?.estoque_disponivel
    }]];
  }));
}
