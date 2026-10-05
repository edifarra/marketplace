/** Only exact marketplace IDs can be used as remote read/delete watermarks. */
export function validShopeeMessageId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^[1-9]\d{0,19}$/.test(id) ? id : "";
}

export function latestShopeeMessageId(messages: Array<Record<string, any>>) {
  let latest = "";
  for (const message of messages) {
    const id = validShopeeMessageId(message.message_id ?? message.external_message_id ?? message.id);
    if (id && (!latest || BigInt(id) > BigInt(latest))) latest = id;
  }
  return latest;
}

// Matching logic also runs under the database row lock to cover concurrent syncs.
export function reconcileShopeeChatManagement(input: Record<string, any>, existing: Record<string, any> | null) {
  if (!existing) return input;
  const latest = latestShopeeMessageId([{ message_id: input.shopee_last_message_id }, { message_id: existing.shopee_last_message_id }]);
  const incoming = latestShopeeMessageId([{ message_id: input.shopee_last_incoming_message_id }, { message_id: existing.shopee_last_incoming_message_id }]);
  const read = validShopeeMessageId(existing.shopee_read_message_id);
  const deleted = validShopeeMessageId(existing.shopee_deleted_message_id);
  return {
    ...input,
    shopee_last_message_id: latest || null,
    shopee_last_incoming_message_id: incoming || null,
    ...(read && latest && BigInt(latest) <= BigInt(read) ? { unread: false } : {}),
    ...(existing.shopee_deleted_at && latest && deleted && BigInt(latest) > BigInt(deleted)
      ? { shopee_deleted_at: null } : {})
  };
}

export function assertShopeeChatReceipt(payload: Record<string, any>) {
  if (payload.error || typeof payload.request_id !== "string" || !payload.request_id
    || !payload.response || typeof payload.response !== "object" || Array.isArray(payload.response))
    throw new Error("A Shopee não confirmou a ação do chat com uma resposta válida.");
}
