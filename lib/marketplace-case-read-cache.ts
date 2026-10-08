import "server-only";
import { CaseReadCache } from "./case-read-cache";
import { loadCaseDetail } from "./marketplace-case-detail";
import { loadCaseList, type CaseFilters } from "./marketplace-case-list";
import { supabaseAdmin } from "./supabase-admin";
import { getCurrentUser } from "./auth";
const detailCache = new CaseReadCache<Awaited<ReturnType<typeof loadCaseDetail>>>();
const listCache = new CaseReadCache<Awaited<ReturnType<typeof loadCaseList>>>();
export async function caseReadScope() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Sessão expirada.");
  const revision = await supabaseAdmin().from("marketplace_case_cache_revision").select("revision").eq("singleton", true).single().throwOnError();
  return { scope: `${user.id}:${user.sessionVersion}:${user.isMaster}`, revision: String(revision.data.revision) };
}
export async function cachedCaseList(filters: CaseFilters, scope: string, revision: string) {
  const key = JSON.stringify([scope, revision, Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))]);
  return listCache.get(key, () => loadCaseList(filters));
}
export async function cachedCaseDetail(id: string, scope: string, revision: string, before?: {at: string; id: string; sent: string | null}) {
  const db = supabaseAdmin();
  // The UUID is globally unique; resolve account/marketplace before selecting the cache partition.
  const identity = await db.from("marketplace_cases").select("marketplace,marketplace_account_id,updated_at,read_control:marketplace_case_sync_control(case_revision)").eq("id", id).maybeSingle().throwOnError();
  if (!identity.data) return null;
  const row = identity.data as any;
  const caseRevision = row.updated_at ? `${row.updated_at}:${row.read_control?.case_revision || 0}` : revision;
  const key = JSON.stringify([scope, row.marketplace, row.marketplace_account_id, id, caseRevision, before || null]);
  return detailCache.get(key, async () => { const data = await loadCaseDetail(id, db, before); return data ? { ...data, _localCacheLoadedAt: Date.now() } : null; });
}
