import "server-only";
import { supabaseAdmin } from "./supabase-admin";
import { CASE_LIST_SELECT, caseSaleItems, knownCaseDeadlines } from "./marketplace-case-list";
type Row = Record<string, any>;
export function safeCaseConversation(candidates: Row[], marketplace: string, account: string, order: string | null) {
  if (!order) return null;
  const matches = candidates.filter(c => c.marketplace === marketplace && c.marketplace_account_id === account && c.order_id === order && ["chat", "post_sale"].includes(c.conversation_type));
  return matches.length === 1 ? matches[0] : null;
}
async function readChildren(db: ReturnType<typeof supabaseAdmin>, table: string, select: string, caseId: string, order: string) {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await db.from(table).select(select).eq("case_id", caseId).order(order).order("id").range(offset, offset + 499).throwOnError();
    rows.push(...(r.data || []));
    if ((r.data || []).length < 500) return rows;
  }
}
export async function loadCaseDetail(id: string, db = supabaseAdmin(), before?: { at: string; id: string; sent: string | null }) {
  const result = await db.from("marketplace_cases").select(`${CASE_LIST_SELECT},resolution,seller_proof_status:content->>seller_proof_status,negotiation_status:content->>negotiation_status`).eq("id", id).maybeSingle().throwOnError();
  const row = result.data as unknown as Row | null;
  if (!row) return null;
  const sale = row.sale?.marketplace === row.marketplace && (!row.order_id || row.sale.order_id === row.order_id) ? row.sale : null;
  const order = row.order_id || sale?.order_id || null;
  const skus = [...new Set<string>([...(sale?.items || []).map((i: Row) => i.sku), ...(row.item?.sku ? [row.item.sku] : [])])];
  const products: Row[] = [];
  for (let offset = 0; offset < skus.length; offset += 100) {
    const r = await db.from("products").select("id,sku,title,product_images(url,cloudinary_url,position)").in("sku", skus.slice(offset, offset + 100)).throwOnError();
    products.push(...(r.data || []));
  }
  const [conversations, observations, timeline, actions, evidence] = await Promise.all([
    order ? db.from("marketplace_conversations").select("id,marketplace,marketplace_account_id,order_id,conversation_type,buyer_name,buyer_id")
      .eq("marketplace", row.marketplace).eq("marketplace_account_id", row.marketplace_account_id).eq("order_id", order).in("conversation_type", ["chat", "post_sale"]).limit(2).throwOnError() : Promise.resolve({ data: [] }),
    row.snapshot_order_at ? db.from("marketplace_case_observations").select("order_at,deadlines:marketplace_case_deadlines(purpose,responsible,value,precision,timezone,validity)")
      .eq("case_id", id).eq("order_at", row.snapshot_order_at).order("observed_at", { ascending: false }).order("id").limit(1).throwOnError() : Promise.resolve({ data: [] }),
    readChildren(db, "marketplace_case_timeline", "id,event_type,state,actor,official_at,observed_at", id, "observed_at"),
    readChildren(db, "marketplace_case_actions", "id,action_code,mandatory,deadline,observed_at", id, "observed_at"),
    readChildren(db, "marketplace_case_evidence", "id,media_type,reference,metadata", id, "id")
  ]);
  const conversation = safeCaseConversation(conversations.data || [], row.marketplace, row.marketplace_account_id, order);
  let messageQuery = db.from("marketplace_conversation_messages").select("id,direction,message_type,text,sender_name,sent_at,created_at").eq("conversation_id", conversation?.id || "00000000-0000-0000-0000-000000000000");
  if (before) {
    const receivedBefore = `created_at.lt.${before.at},and(created_at.eq.${before.at},id.lt.${before.id})`;
    messageQuery = before.sent ? messageQuery.or(`sent_at.lt.${before.sent},sent_at.is.null,and(sent_at.eq.${before.sent},or(${receivedBefore}))`) : messageQuery.is("sent_at", null).or(receivedBefore);
  }
  const messages = conversation ? await messageQuery.order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(101).throwOnError() : { data: [] };
  const recent = (messages.data || []).slice(0, 100).reverse();
  return { row, items: caseSaleItems(row, products), deadlines: knownCaseDeadlines({ ...row, observations: observations.data }, true),
    conversation, messages: recent, olderMessages: (messages.data || []).length > 100,
    timeline: timeline.sort((a, b) => Date.parse(a.official_at || a.observed_at) - Date.parse(b.official_at || b.observed_at) || a.id.localeCompare(b.id)), actions, evidence };
}
