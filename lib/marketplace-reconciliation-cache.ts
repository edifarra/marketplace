export type ReconciliationRoundCache = {
  productsByListing: Map<string, Promise<Record<string, any>>>;
  orders: Map<string, Promise<Record<string, any> | null>>;
  productsBySku: Map<string, Promise<Record<string, any> | null>>;
  mercadoLivreBuyers: Map<string, Promise<{ existingName: string; remote: Record<string, any> | null }>>;
};

export function createReconciliationRoundCache(): ReconciliationRoundCache {
  return { productsByListing: new Map(), orders: new Map(), productsBySku: new Map(), mercadoLivreBuyers: new Map() };
}

export function cachedRoundLookup<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key)!;
}
