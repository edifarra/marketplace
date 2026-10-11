import { normalizeMercadoLivrePostSale } from "./mercado-livre-post-sale";

type Row = Record<string, any>;
export type HistoryDependencies = {
  acquire: (key: string, claimAt: string, now: number) => Promise<boolean>;
  finish: (key: string, value: Row) => Promise<void>;
  read: (path: string) => Promise<Row>;
  persist: (remote: Row, context: Row) => Promise<unknown>;
};

export function historyCacheFresh(value: Row, claimAt: string, now: number) {
  return (value.result === "success" && Date.parse(value.coveredThrough) >= Date.parse(claimAt))
    || Date.parse(value.retryAt) > now;
}

// Runs only for a seller-validated order from claim enrichment; never discovers unread chats.
export async function recoverClaimChatHistory(account: Row, order: Row, claimAt: string, deps: HistoryDependencies, now = Date.now()) {
  const sellerId = String(account.seller_id || account.account_id || "");
  if (!account.id || !sellerId || !order.id || String(order.seller?.id) !== sellerId || !Number.isFinite(Date.parse(claimAt))) return "invalid_identity";
  const orderId = String(order.id), packId = String(order.pack_id || order.id);
  const key = `ml-claim-chat-history:${account.id}:${orderId}`;
  let acquired = false;
  try {
    if (!await deps.acquire(key, claimAt, now)) return "cached";
    acquired = true;
    const conversationPath = `/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}`;
    const remote = await deps.read(conversationPath);
    const messages = normalizeMercadoLivrePostSale(remote, sellerId, account.id);
    if (messages.some(m => m.sellerId !== sellerId || (m.packId && m.packId !== packId) || (m.orderId && m.orderId !== orderId))) throw new Error("History identity mismatch");
    if (messages.length) await deps.persist(remote, { orderId, packId, sellerId, conversationPath });
    await deps.finish(key, { result: "success", attemptedAt: new Date(now).toISOString(), coveredThrough: new Date(now).toISOString() });
    return "success";
  } catch (error) {
    const result = (error as { status?: number })?.status === 404 ? "not_found" : "transient_error";
    // Same one-hour negative TTL as pack resolution. Network failures retry at the normal 15-minute cache boundary.
    if (acquired) try { await deps.finish(key, { result, attemptedAt: new Date(now).toISOString(), retryAt: new Date(now + (result === "not_found" ? 60 : 15) * 60_000).toISOString() }); } catch { /* History must never fail the claim bundle. */ }
    return result;
  }
}

export function priorClaimChatMessages(messages: Row[], claimAt: string | null, claimMessages: Row[] = []) {
  const cutoff = Date.parse(claimAt || "");
  if (!Number.isFinite(cutoff)) return [];
  const claimIds = new Set(claimMessages.map(m => m.external_message_id).filter(Boolean));
  const unique = new Map<string, Row>();
  for (const m of messages) {
    if (Date.parse(m.sent_at) < cutoff && !claimIds.has(m.external_message_id)) unique.set(m.external_message_id || m.id, m);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || String(a.id).localeCompare(String(b.id)));
}
