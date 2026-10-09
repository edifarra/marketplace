import "server-only";
import { supabaseAdmin } from "./supabase-admin";
import { CASE_LIST_SELECT, caseSaleItems, knownCaseDeadlines } from "./marketplace-case-list";
import { orderedClaimTimeline,saleOfficialEvents } from "./marketplace-claim-timeline";
import { shopeeReturnPushMilestones } from "./shopee-return-milestones";
type Row = Record<string, any>;
export function safeClaimConversation(candidates:Row[],account:string,claim:string) {
  const matches=candidates.filter(c=>c.marketplace === "mercado_livre" && c.marketplace_account_id === account && c.conversation_type === "claim" && c.external_conversation_id === `claim:${claim}`);
  return matches.length === 1 ? matches[0] : null;
}
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
  const result = await db.from("marketplace_cases").select(`${CASE_LIST_SELECT},resolution,stage,refund_amount:content->refund_amount,currency:content->>currency,return_created_at:content->>return_created_at,return_milestones:content->return_milestones,claim_created_at:content->>claim_created_at,buyer_data:content->buyer_data,current_claim:content->current_claim,seller_proof_status:content->>seller_proof_status,negotiation_status:content->>negotiation_status`).eq("id", id).maybeSingle().throwOnError();
  const row = result.data as unknown as Row | null;
  if (!row) return null;
  const sale = row.sale?.marketplace === row.marketplace && (!row.order_id || row.sale.order_id === row.order_id) ? row.sale : null;
  const order = row.order_id || sale?.order_id || null;
  const isClaim=row.marketplace === "mercado_livre" && row.case_type === "claim";
  const skus = [...new Set<string>([...(sale?.items || []).map((i: Row) => i.sku), ...(row.item?.sku ? [row.item.sku] : [])])];
  const products: Row[] = [];
  for (let offset = 0; offset < skus.length; offset += 100) {
    const r = await db.from("products").select("id,sku,title,product_images(url,local_url,cloudinary_url,position)").in("sku", skus.slice(offset, offset + 100)).throwOnError();
    products.push(...(r.data || []));
  }
  const [conversations, observations, timeline, actions, evidence] = await Promise.all([
    isClaim ? db.from("marketplace_conversations").select("id,marketplace,marketplace_account_id,order_id,conversation_type,buyer_name,buyer_id,external_conversation_id")
      .eq("marketplace","mercado_livre").eq("marketplace_account_id",row.marketplace_account_id).eq("conversation_type","claim").eq("external_conversation_id",`claim:${row.external_case_id}`).limit(2).throwOnError() : order ? db.from("marketplace_conversations").select("id,marketplace,marketplace_account_id,order_id,conversation_type,buyer_name,buyer_id")
      .eq("marketplace", row.marketplace).eq("marketplace_account_id", row.marketplace_account_id).eq("order_id", order).in("conversation_type", ["chat", "post_sale"]).limit(2).throwOnError() : Promise.resolve({ data: [] }),
    row.snapshot_order_at ? db.from("marketplace_case_observations").select("order_at,deadlines:marketplace_case_deadlines(purpose,responsible,value,precision,timezone,validity)")
      .eq("case_id", id).eq("order_at", row.snapshot_order_at).order("observed_at", { ascending: false }).order("id").limit(1).throwOnError() : Promise.resolve({ data: [] }),
    readChildren(db, "marketplace_case_timeline", "id,event_type,state,actor,official_at,observed_at", id, "observed_at"),
    row.snapshot_order_at ? db.from("marketplace_case_observations").select("actions:marketplace_case_actions(id,action_code,mandatory,deadline,observed_at)").eq("case_id",id).eq("order_at",row.snapshot_order_at)
      .order("observed_at",{ascending:false}).order("id").limit(1).throwOnError().then(result=>(result.data?.[0] as any)?.actions || []) : Promise.resolve([]),
    readChildren(db, "marketplace_case_evidence", "id,media_type,reference,metadata", id, "id")
  ]);
  const conversation = isClaim ? safeClaimConversation(conversations.data || [],row.marketplace_account_id,row.external_case_id) : safeCaseConversation(conversations.data || [], row.marketplace, row.marketplace_account_id, order);
  let messageQuery = db.from("marketplace_conversation_messages").select("id,direction,message_type,text,sender_name,sent_at,created_at,status,raw_data").eq("conversation_id", conversation?.id || "00000000-0000-0000-0000-000000000000");
  if (before) {
    const receivedBefore = `created_at.lt.${before.at},and(created_at.eq.${before.at},id.lt.${before.id})`;
    messageQuery = before.sent ? messageQuery.or(`sent_at.lt.${before.sent},sent_at.is.null,and(sent_at.eq.${before.sent},or(${receivedBefore}))`) : messageQuery.is("sent_at", null).or(receivedBefore);
  }
  const messages = conversation ? await messageQuery.order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(101).throwOnError() : { data: [] };
  const recent = (messages.data || []).slice(0, 100).reverse();
  if (row.marketplace === "shopee" && !before) {
    // Read normalized case provenance, not chat history or Shopee APIs.
    const saved = await readChildren(db, "marketplace_case_observations", "id,source_key,return_milestones:snapshot->return_milestones,return_created_at:snapshot->>return_created_at", id, "order_at");
    const milestones = [...(Array.isArray(row.return_milestones) ? row.return_milestones : []), ...saved.flatMap(o => Array.isArray(o.return_milestones) ? o.return_milestones : [])];
    const sources = [...new Set<string>(saved.filter(o => !o.return_milestones).map(o => String(o.source_key || "").split(":")[0]).filter(key => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key)))];
    // Legacy snapshots omitted updated_values; recover from their exact linked activity IDs.
    for (let offset = 0; offset < sources.length; offset += 100) {
      const activities = await db.from("marketplace_activities").select("id,raw_payload").eq("marketplace", "shopee").in("id", sources.slice(offset, offset + 100)).throwOnError();
      for (const activity of activities.data || []) {
        const payload = activity.raw_payload?.notification || activity.raw_payload || {};
        if (payload.data?.return_sn === row.external_case_id && (!order || payload.data?.order_sn === order)) milestones.push(...shopeeReturnPushMilestones(payload));
      }
    }
    row.return_milestones = [...new Map(milestones.map(m => [m.kind + ":" + m.at, m])).values()];
    row.return_created_at ||= saved.find(o => o.return_created_at)?.return_created_at || null;
  }
  const pendingOperation=isClaim ? (await db.from("outgoing_marketplace_activities").select("id,status,remote_execution_state").eq("activity_type","claim_action")
    .eq("source_id",id).eq("marketplace_account_id",row.marketplace_account_id).or("status.in.(queued,processing,retry),remote_execution_state.in.(sending,uncertain,succeeded)").order("updated_at",{ascending:false}).limit(1).throwOnError()).data?.[0] : null;
  let visibleTimeline=timeline;
  if(isClaim) {
    const sourceSale=sale ? (await db.from("venda").select("id,order_id,marketplace,shipment_id,raw_data").eq("id",sale.id).maybeSingle().throwOnError()).data : null;
    const official=timeline.filter(e=>e.event_type!=="state_observed");
    visibleTimeline=orderedClaimTimeline([...saleOfficialEvents(sourceSale),...official]);
  }
  return { row, items: caseSaleItems(row, products), deadlines: knownCaseDeadlines({ ...row, observations: observations.data }, true),
    conversation, messages: recent, olderMessages: (messages.data || []).length > 100, pendingOperation,
    messageScope: isClaim ? "case" : "order_context",
    timeline: isClaim ? visibleTimeline : timeline.sort((a, b) => Date.parse(a.official_at || a.observed_at) - Date.parse(b.official_at || b.observed_at) || a.id.localeCompare(b.id)), actions, evidence };
}
