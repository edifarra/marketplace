export type MercadoLivreSaleIdentifier = {
  identifierType: string;
  identifierValue: string;
};

/** Extracts identifiers returned by the official order API without guessing missing values. */
export function extractMercadoLivreSaleIdentifiers(order: Record<string, any>): MercadoLivreSaleIdentifier[] {
  const identifiers = new Map<string, MercadoLivreSaleIdentifier>();
  const add = (type: string, value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return;
    const identifierValue = String(value).trim();
    if (!identifierValue) return;
    identifiers.set(`${type}\u0000${identifierValue}`, { identifierType: type, identifierValue });
  };

  add("ORDER_ID", order.id);
  add("PACK_ID", order.pack_id ?? order.pack?.id);
  add("SHIPPING_ID", order.shipping?.id ?? order.shipping_id);
  for (const payment of Array.isArray(order.payments) ? order.payments : []) add("PAYMENT_ID", payment?.id);

  // Preserve additional official identifiers that are explicitly represented as IDs.
  for (const [field, type] of Object.entries({ cart: "CART_ID", context: "CONTEXT_ID" })) {
    add(type, order[field]?.id);
  }
  return [...identifiers.values()];
}
