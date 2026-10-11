import type { SupabaseClient } from "@supabase/supabase-js";

export type LocalPackOrder = { orderId: string | null; ambiguous: boolean };

// Each branch is account-scoped and capped at two: enough to detect ambiguity,
// without relying on PostgREST's default row limit or an absent venda.pack_id.
export async function localMercadoLivreOrderForPack(db: SupabaseClient, accountId: string, packId: string, orderIds: string[] = []): Promise<LocalPackOrder> {
  if (!accountId || !packId) return { orderId: null, ambiguous: false };
  const candidates = [...new Set([packId, ...orderIds].filter(Boolean))];
  const base = () => db.from("venda").select("order_id")
    .eq("marketplace", "mercado_livre").eq("raw_data->>marketplace_account_id", accountId);
  const results = await Promise.all([
    base().in("order_id", candidates).limit(2).throwOnError(),
    base().eq("raw_data->payload->order->>pack_id", packId).limit(2).throwOnError(),
    base().eq("raw_data->payload->shipment->>pack_id", packId).limit(2).throwOnError()
  ]);
  const ids = new Set(results.flatMap(result => (result.data || []).map(row => String(row.order_id || "")).filter(Boolean)));
  return { orderId: ids.size === 1 ? [...ids][0] : null, ambiguous: ids.size > 1 };
}

export const ML_PACK_NOT_FOUND_TTL_MS = 60 * 60 * 1000;

export function createMercadoLivrePackCache(now: () => number = Date.now) {
  const missing = new Map<string, number>();
  const inflight = new Map<string, Promise<Record<string, any> | null>>();
  return {
    clear() { missing.clear(); },
    async load(accountId: string, packId: string, remote: () => Promise<Record<string, any>>, observeError: (error: unknown) => void) {
      const key = JSON.stringify([accountId, packId]);
      for (const [entry, until] of missing) if (until <= now()) missing.delete(entry);
      if (missing.has(key)) return null;
      const running = inflight.get(key);
      if (running) return running;
      const request = (async () => {
        try { return await remote(); }
        catch (error) {
          // HTTP status, not text matching: auth/network/5xx must reach the queue.
          if ((error as { status?: number } | null)?.status !== 404) throw error;
          if (missing.size >= 1000) missing.delete(missing.keys().next().value!);
          missing.set(key, now() + ML_PACK_NOT_FOUND_TTL_MS);
          observeError(error);
          return null;
        }
      })();
      inflight.set(key, request);
      try { return await request; } finally { inflight.delete(key); }
    }
  };
}

const packCache = createMercadoLivrePackCache();

export function preserveMercadoLivreOrderLink(input: Record<string, any>, existing: Record<string, any> | null) {
  return input.marketplace === "mercado_livre" && input.conversation_type === "post_sale" && !input.order_id && existing?.order_id
    ? { ...input, order_id: existing.order_id } : input;
}

export async function resolveMercadoLivrePackOrder(
  packId: string,
  loadRemotePack: () => Promise<Record<string, any>>,
  findLocalOrder: (candidateOrderIds: string[]) => Promise<LocalPackOrder>,
  observeError: (error: unknown) => void,
  accountId: string,
  cache = packCache
) {
  // Recheck local data even during a negative remote TTL: newly imported orders
  // must recover immediately. Ambiguity must never become an arbitrary order.
  const local = await findLocalOrder([packId]);
  if (local.orderId || local.ambiguous) return local.orderId;
  const pack = await cache.load(accountId, packId, loadRemotePack, observeError);
  if (!pack) return null;
  const ids = [...new Set<string>((Array.isArray(pack.orders) ? pack.orders : [])
    .map((item: any) => String(item.id || item.order_id || "")).filter(Boolean))];
  if (ids.length !== 1) return null;
  const match = await findLocalOrder(ids);
  return match.ambiguous ? null : match.orderId || ids[0];
}

// Compare-and-set protects an existing association and limits repairs to this
// field. The caller logs the returned rows for an auditable, idempotent repair.
export async function linkMercadoLivreConversationOrder(db: SupabaseClient, conversation: { id: string; marketplace_account_id: string; pack_id: string }, orderId: string) {
  return await db.from("marketplace_conversations").update({ order_id: orderId })
    .eq("id", conversation.id).eq("marketplace", "mercado_livre")
    .eq("conversation_type", "post_sale").eq("marketplace_account_id", conversation.marketplace_account_id)
    .eq("pack_id", conversation.pack_id).is("order_id", null).select("id,marketplace_account_id,pack_id,order_id").throwOnError();
}
