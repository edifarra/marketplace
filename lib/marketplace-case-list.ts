import "server-only";
import { supabaseAdmin } from "./supabase-admin";

import { caseContext, CLAIM_CONTEXT_FILTER, RETURN_CONTEXT_FILTER } from "./marketplace-case-context";

type Row = Record<string, any>;
export const CASE_PAGE_SIZE = 30;
export type CaseFilters = { search?: string; marketplace?: string; account?: string; tab?: string; context?: string; page?: string; buyer?: string; site?: string };
export const CASE_GROUPS = ["action", "ongoing", "unknown", "closed"] as const;
export type CaseGroup = typeof CASE_GROUPS[number];
// Only explicit case statuses are classified. Order/shipping status never participates.
const CLOSED = "or(and(marketplace.eq.mercado_livre,status.eq.closed),and(marketplace.eq.shopee,status.in.(CLOSED,CANCELLED)))";
const ONGOING = "or(and(marketplace.eq.mercado_livre,status.in.(open,opened,reopened)),and(marketplace.eq.shopee,status.in.(REQUESTED,PROCESSING,ACCEPTED,JUDGING,SELLER_DISPUTE)))";
const NOT_CLOSED = `not.${CLOSED}`;
// Postgres three-valued logic needs an explicit NULL branch.
const NOT_ONGOING = `or(status.is.null,and(not.${ONGOING},${NOT_CLOSED}))`;
const GROUP_FILTER: Record<CaseGroup, string> = {
  action: `and(needs_action.eq.true,or(status.is.null,${NOT_CLOSED}))`,
  ongoing: `and(${ONGOING},or(needs_action.eq.false,needs_action.is.null))`,
  unknown: `and(or(needs_action.eq.false,needs_action.is.null),${NOT_ONGOING})`,
  closed: CLOSED
};
export function caseGroup(row: Row): CaseGroup {
  const closed = row.marketplace === "mercado_livre" ? row.status === "closed" : ["CLOSED", "CANCELLED"].includes(row.status);
  if (closed) return "closed";
  if (row.needs_action === true) return "action";
  const ongoing = row.marketplace === "mercado_livre" ? ["open", "opened", "reopened"].includes(row.status) : ["REQUESTED", "PROCESSING", "ACCEPTED", "JUDGING", "SELLER_DISPUTE"].includes(row.status);
  return ongoing ? "ongoing" : "unknown";
}
export const CASE_LIST_SELECT = `id,marketplace,marketplace_account_id,external_case_id,case_type,reverse_logistics,responsible,order_id,status,needs_action,reputation_impact,updated_at,official_updated_at,snapshot_order_at,read_control:marketplace_case_sync_control(case_revision),reason:content->>reason,reason_name:content->>reason_name,reason_code:content->>reason_code,current_actions:content->current_actions,buyer_description:content->>buyer_description,validation_type:content->>validation_type,buyer_name:content->>buyer_name,related_claim_id:content->>related_claim_id,
  conversation:marketplace_conversations!conversation_id(buyer_name),
  account:config_marketplace_accounts!marketplace_account_id(id,name,nickname,marketplace),
  product:products!product_id(id,sku,title,product_images(url,cloudinary_url,position)),
  item:venda_item!venda_item_id(id,venda_id,sku,quantidade,valor_total),
  sale:venda!venda_id(id,marketplace,order_id,items:venda_item(id,sku,quantidade,valor_total))`;
const SELECT = CASE_LIST_SELECT;

// Values inside PostgREST logical expressions are quoted, and SQL wildcards escaped.
const pattern = (s: string) => `"%${s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/"/g, '\\"')}%"`;
const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export async function loadCaseList(input: CaseFilters, db = supabaseAdmin()) {
  const filters = { search: (input.search || "").trim().slice(0, 160), marketplace: ["mercado_livre", "shopee"].includes(input.marketplace || "") ? input.marketplace! : "", account: input.account || "", context: input.context === "return" ? "return" : "claim", tab: ["action", "ongoing", "closed"].includes(input.tab || "") ? input.tab! : "all" };
  const site = /^ML[A-Z]$/.test(input.site || "") ? input.site : "";
  const buyer = /^\d+$/.test(input.buyer || "") && filters.account && site && filters.marketplace === "mercado_livre" ? input.buyer : "";
  const accountsResult = await db.from("config_marketplace_accounts").select("id,name,nickname,marketplace").order("name").throwOnError();
  const accounts = accountsResult.data || [];
  if (!accounts.some(a => a.id === filters.account)) filters.account = "";
  // Resolve catalog descriptions to exact, existing sale SKUs. Never load full product snapshots.
  const skus: string[] = [];
  if (filters.search) {
    for (let offset = 0; ; offset += 500) {
      const result = await db.from("products").select("sku").or(`title.ilike.${pattern(filters.search)},sku.ilike.${pattern(filters.search)}`).order("id").range(offset, offset + 499).throwOnError();
      skus.push(...(result.data || []).map(p => p.sku));
      if ((result.data || []).length < 500) break;
    }
  }
  const searchSelect = filters.search ? `,search_product:products!product_id(),search_item:venda_item!venda_item_id(),search_sale:venda!venda_id(),search_sale_items:venda!venda_id(search_items:venda_item!inner()),search_conversation:marketplace_conversations!conversation_id()` : "";
  const compactSelect = "id,marketplace,case_type,reverse_logistics,status,needs_action,updated_at";
  const query = (group: CaseGroup | null, head: boolean, compact = false, skuChunk?: string[], context: string | null = filters.context) => {
    let q = db.from("marketplace_cases").select((head ? "id" : compact ? compactSelect : SELECT) + searchSelect, { count: "exact", head });
    if (context) q = q.or(context === "return" ? RETURN_CONTEXT_FILTER : CLAIM_CONTEXT_FILTER);
    if (group) q = q.or(GROUP_FILTER[group]);
    if (filters.marketplace) q = q.eq("marketplace", filters.marketplace);
    if (filters.account) q = q.eq("marketplace_account_id", filters.account);
    if (buyer) q = q.eq("content->buyer_data->>id",buyer).eq("content->buyer_data->>site_id",site);
    if (filters.search) {
      const p = pattern(filters.search);
      q = q.or(`title.ilike.${p},sku.ilike.${p}`, { referencedTable: "search_product" })
        .ilike("search_item.sku", `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`)
        .ilike("search_sale.order_id", `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`)
        .or(skuChunk ? `sku.in.(${skuChunk.map(quoted).join(",")})` : `sku.ilike.${p}`, { referencedTable: "search_sale_items.search_items" })
        .ilike("search_conversation.buyer_name", `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`)
        .or(skuChunk ? "search_sale_items.not.is.null" : `external_case_id.ilike.${p},order_id.ilike.${p},content->>buyer_name.ilike.${p},content->buyer_data->>display_name.ilike.${p},content->buyer_data->>legal_name.ilike.${p},reverse_logistics->>contact_name.ilike.${p},reverse_logistics->>tracking.ilike.${p},reverse_logistics->>return_id.ilike.${p},search_conversation.not.is.null,search_product.not.is.null,search_item.not.is.null,search_sale.not.is.null,search_sale_items.not.is.null`);
    }
    return q;
  };
  // Broad description searches can match thousands of SKUs: bounded URL batches,
  // paged compact matching identities, and deduplication before counting/pagination.
  // Full case/sale/product data is still fetched only for the visible page.
  let matches: Row[] | undefined;
  if (filters.search) {
    const unique = new Map<string, Row>();
    const chunks: Array<string[] | undefined> = [undefined];
    for (let i = 0; i < skus.length; i += 60) chunks.push(skus.slice(i, i + 60));
    for (const chunk of chunks) {
      for (let offset = 0; ; offset += 500) {
        const r = await query(null, false, true, chunk, null).order("id").range(offset, offset + 499).throwOnError();
        for (const row of (r.data || []) as unknown as Row[]) unique.set(row.id, row);
        if ((r.data || []).length < 500) break;
      }
    }
    matches = [...unique.values()];
  }
  const contextCounts = { claim: 0, return: 0 };
  if (matches) {
    for (const row of matches) contextCounts[caseContext(row)]++;
    matches = matches.filter(row => caseContext(row) === filters.context);
  } else {
    const result = await Promise.all(["claim", "return"].map(context => query(null, true, false, undefined, context).throwOnError()));
    contextCounts.claim = result[0].count || 0; contextCounts.return = result[1].count || 0;
  }
  const counts = { action: 0, ongoing: 0, unknown: 0, closed: 0 };
  if (matches) for (const row of matches) counts[caseGroup(row)]++;
  else {
    const countsResult = await Promise.all(CASE_GROUPS.map(g => query(g, true).throwOnError()));
    CASE_GROUPS.forEach((g, i) => { counts[g] = countsResult[i].count || 0; });
  }
  const groups = filters.tab === "all" ? [...CASE_GROUPS] : [filters.tab as CaseGroup];
  const total = groups.reduce((n, g) => n + counts[g], 0);
  const pages = Math.max(1, Math.ceil(total / CASE_PAGE_SIZE));
  const requested = Number(input.page);
  const page = Math.min(pages, Number.isSafeInteger(requested) && requested > 0 ? requested : 1);
  let skip = (page - 1) * CASE_PAGE_SIZE, remaining = CASE_PAGE_SIZE;
  const requests = [];
  const visibleMatches = matches?.filter(r => groups.includes(caseGroup(r))).sort((a, b) => CASE_GROUPS.indexOf(caseGroup(a)) - CASE_GROUPS.indexOf(caseGroup(b)) || Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.id.localeCompare(b.id)).slice(skip, skip + remaining);
  if (visibleMatches?.length) requests.push(db.from("marketplace_cases").select(SELECT).in("id", visibleMatches.map(r => r.id)).throwOnError());
  for (const group of matches ? [] : groups) {
    if (skip >= counts[group]) { skip -= counts[group]; continue; }
    const take = Math.min(remaining, counts[group] - skip);
    if (take) requests.push(query(group, false).order("updated_at", { ascending: false }).order("id").range(skip, skip + take - 1).throwOnError());
    remaining -= take; skip = 0;
    if (!remaining) break;
  }
  const rows = (await Promise.all(requests)).flatMap(r => (r.data || []) as unknown as Row[]);
  if (visibleMatches) rows.sort((a, b) => visibleMatches.findIndex(r => r.id === a.id) - visibleMatches.findIndex(r => r.id === b.id));
  // Read only observation metadata for the exact persisted snapshot timestamp.
  // A newer identity-only observation must not hide deadlines of the retained snapshot.
  const snapshots = rows.filter(r => r.snapshot_order_at).map(r => `and(case_id.eq.${r.id},order_at.eq.${quoted(r.snapshot_order_at)})`);
  if (snapshots.length) {
    const current = new Map<string, Row>();
    for (let offset = 0; ; offset += 500) {
      const result = await db.from("marketplace_case_observations")
        .select("id,case_id,order_at,observed_at,deadlines:marketplace_case_deadlines(purpose,responsible,value,precision,timezone,validity)")
        .or(snapshots.join(",")).order("observed_at", { ascending: false }).order("id").range(offset, offset + 499).throwOnError();
      for (const observation of result.data || []) if (!current.has(observation.case_id)) current.set(observation.case_id, observation);
      if ((result.data || []).length < 500) break;
    }
    for (const row of rows) row.observations = current.has(row.id) ? [current.get(row.id)] : [];
  }
  const saleSkus = [...new Set(rows.flatMap(r => [...(r.sale?.items || []).map((i: Row) => String(i.sku)), ...(r.item?.sku ? [String(r.item.sku)] : [])]))];
  const products: Row[] = [];
  for (let i = 0; i < saleSkus.length; i += 100) {
    const result = await db.from("products").select("id,sku,title,product_images(url,cloudinary_url,position)").in("sku", saleSkus.slice(i, i + 100)).throwOnError();
    products.push(...(result.data || []));
  }
  return { rows, products, accounts, counts, contextCounts, total, pages, page, filters:{...filters,buyer,site:buyer ? site : ""} };
}

export function caseSaleItems(row: Row, products: Row[]) {
  const sale = row.sale?.marketplace === row.marketplace && (!row.order_id || row.sale.order_id === row.order_id) ? row.sale : null;
  if (row.item && (!row.sale || (sale && row.item.venda_id === sale.id))) return [{ ...row.item, product: row.product?.sku === row.item.sku ? row.product : products.find(p => p.sku === row.item.sku), scope: "case" }];
  if (row.product) return [{ sku: row.product.sku, product: row.product, quantidade: null, valor_total: null, scope: "case" }];
  return (sale?.items || []).map((i: Row) => ({ ...i, product: products.find(p => p.sku === i.sku), scope: "sale" }));
}
export function knownCaseDeadlines(row: Row, includeUnknown = false) {
  const observation = row.observations?.[0];
  if (!observation || new Date(observation.order_at).getTime() !== new Date(row.snapshot_order_at).getTime()) return [];
  return (observation.deadlines || []).filter((d: Row) => d.value && ["date", "timestamp"].includes(d.precision) && d.validity === "observed" && (includeUnknown || ["buyer_return_shipping", "seller_response", "seller_evidence", "seller_validation", "logistics", "auto_close"].includes(d.purpose) || /^action:[a-zA-Z0-9_]+$/.test(d.purpose)));
}
