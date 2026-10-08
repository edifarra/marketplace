import { CaseReadCache, CASE_CACHE_MS } from "@/lib/case-read-cache";
type Row = Record<string, any>;
const cache = new CaseReadCache<Row>();
const prefix = "central-case-v1:";
const generations = new Map<string, number>();
export const detailCacheKey = (scope: string, revision: string, row: Row) => JSON.stringify([scope, row.marketplace, row.marketplace_account_id, row.id, row.updated_at ? `${row.updated_at}:${row.read_control?.case_revision || 0}` : revision]);
const valid = (data: Row, id: string) => data?.row?.id === id && Array.isArray(data.messages) && Array.isArray(data.timeline) && Array.isArray(data.evidence) && Array.isArray(data.items) && Array.isArray(data.deadlines);
function store(key: string, data: Row, expires: number) {
  try {
    // Bound both ordinary reads and known updates; storage is scoped to this browser tab.
    for (const old of Object.keys(sessionStorage).filter(k => k.startsWith(prefix))) {
      try { const entry = JSON.parse(sessionStorage.getItem(old) || "null"); if (!entry || entry.expires <= Date.now()) sessionStorage.removeItem(old); }
      catch { sessionStorage.removeItem(old); }
    }
    const keys = Object.keys(sessionStorage).filter(k => k.startsWith(prefix) && k !== prefix + key);
    while (keys.length >= 40) sessionStorage.removeItem(keys.shift()!);
    sessionStorage.setItem(prefix + key, JSON.stringify({ value: data, expires }));
  } catch { /* Disabled/full browser storage cannot break local reads. */ }
}
export function updateCaseCache(key: string, data: Row, knownChange = true) {
  const loadedAt = knownChange ? Date.now() : data._localCacheLoadedAt || Date.now();
  data = { ...data, _localCacheLoadedAt: loadedAt };
  generations.set(key, (generations.get(key) || 0) + 1);
  if (generations.size > 100) generations.delete(generations.keys().next().value!);
  cache.invalidate(key); cache.put(key, data, loadedAt + CASE_CACHE_MS);
  store(key, data, loadedAt + CASE_CACHE_MS);
}
export function invalidateCaseCache(key: string) {
  generations.set(key, (generations.get(key) || 0) + 1);
  cache.invalidate(key); try { sessionStorage.removeItem(prefix + key); } catch {}
}
export async function readCaseCache(key: string, id: string) {
  try {
    const entry = JSON.parse(sessionStorage.getItem(prefix + key) || "null");
    if (entry?.expires > Date.now() && valid(entry.value, id)) cache.put(key, entry.value, entry.expires);
  } catch {}
  return cache.get(key, async () => {
    const generation = generations.get(key) || 0;
    const response = await fetch(`/api/central-reclamacoes/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível ler os detalhes locais do Caso.");
    const data = await response.json();
    if (!valid(data, id)) throw new Error("Resposta local incompleta.");
    // The cache itself handles in-flight deduplication. Do not cancel a shared request on collapse.
    if ((generations.get(key) || 0) !== generation) throw new Error("Os dados locais mudaram durante a leitura. Reabra o caso.");
    store(key, data, (data._localCacheLoadedAt || Date.now()) + CASE_CACHE_MS);
    return data;
  }, data => valid(data, id), data => (data._localCacheLoadedAt || Date.now()) + CASE_CACHE_MS);
}
