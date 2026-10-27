import { getValidMercadoLivreAccessToken, mlGet, MarketplaceAccountConfig } from "./mercado-livre";
import { getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { claimBuyerId, claimSeller } from "./marketplace-claim-domain";
import { supabaseAdmin } from "./supabase-admin";
import { historyCacheFresh, recoverClaimChatHistory } from "./marketplace-claim-chat-history";
import { getMercadoLivrePostSaleConversation } from "./mercado-livre";
import { persistMercadoLivrePostSale } from "./marketplace-conversations";
import { randomUUID } from "node:crypto";
import { validReturnCost } from "./claim-return-cost";

export async function loadMercadoLivreClaimBundle(id: string, account: MarketplaceAccountConfig,
  get?: (path: string) => Promise<Record<string, any>>, history?: (order: Record<string, any>, claimAt: string) => Promise<unknown>, options: {financial?:boolean} = {}) {
  let token: Promise<string> | undefined;
  const read = get || (async (path: string) => mlGet(path, await (token ||= getValidMercadoLivreAccessToken(account)), {}, AbortSignal.timeout(20_000)));
  const root = `/post-purchase/v1/claims/${encodeURIComponent(id)}`;
  const detail = await read(root);
  if (String(detail.id) !== id) throw new Error("Claim retornado não corresponde ao evento.");
  const resources: Record<string, any> = {};
  const optional = async (key:string,path:string,fallback:any={}) => {
    try {
      const result=await read(path);
      const list=['messages','actions','statuses','resolutions','shipment_orders'].includes(key);
      if((list && !Array.isArray(result)) || (!list && (!result || typeof result!=='object' || Array.isArray(result)))) {
        resources[key]={state:'unavailable',endpoint:path,code:'invalid_response_shape'};return fallback;
      }
      if(key==='reputation' && !['affected','not_affected','not_applies'].includes(result.affects_reputation)) {
        resources[key]={state:'unavailable',endpoint:path,code:'invalid_response_shape'};return fallback;
      }
      resources[key]={state:'obtained',endpoint:path};return result;
    }
    catch(e) { const status=Number((e as any)?.status); resources[key]={state:'unavailable',endpoint:path,code:'resource_unavailable',...(Number.isInteger(status) && status>=400 && status<=599 ? {http_status:status} : {})};return fallback; }
  };
  const [reason,reputation,messages,actions,statuses,resolutions] = await Promise.all([
    detail.reason_id ? optional('reason',`/post-purchase/v1/claims/reasons/${encodeURIComponent(detail.reason_id)}`) : Promise.resolve({}),
    optional('reputation',`${root}/affects-reputation`),optional('messages',`${root}/messages`,[]),optional('actions',`${root}/actions-history`,[]),optional('statuses',`${root}/status-history`,[]),optional('resolutions',`${root}/expected-resolutions`,[])
  ]);
  const sellerId=String(account.seller_id || account.account_id || "");
  const buyerId=claimBuyerId(detail);
  let buyer: Record<string,any> | null=null;
  if(detail.resource === "order" && buyerId && claimSeller(detail,sellerId)) {
    const order=await optional('order',`/orders/${encodeURIComponent(String(detail.resource_id))}`);
    if(String(order.id)===String(detail.resource_id) && String(order.seller?.id)===sellerId && String(order.buyer?.id)===buyerId) {
    if (history) { try { await history(order, detail.date_created); } catch { /* Optional context cannot block the claim. */ } }
    buyer={id:buyerId,site_id:detail.site_id,nickname:order.buyer.nickname || null,
      display_name:[order.buyer.first_name,order.buyer.last_name].filter(Boolean).join(" ") || order.buyer.nickname || null,
      billing_info_id:order.buyer.billing_info?.id || null,products:(order.order_items || []).map((i:any)=>({title:i.item?.title,quantity:i.quantity,amount:i.unit_price})),
      order_amount:order.total_amount,paid_amount:order.paid_amount,currency:order.currency_id};
    if(buyer.billing_info_id && detail.site_id) {
      const billing=await optional('billing',`/orders/billing-info/${encodeURIComponent(detail.site_id)}/${encodeURIComponent(buyer.billing_info_id)}`);
      if(String(billing.buyer?.cust_id)===buyerId && String(billing.seller?.cust_id)===sellerId) {
      const b=billing.buyer.billing_info || {};
      buyer={...buyer,legal_name:b.name || null,document_type:b.identification?.type || null,document_number:b.identification?.number || null,
        fiscal_address:b.address || null,customer_type:b.attributes?.cust_type || null,taxpayer_type:b.taxes?.taxpayer_type?.description || null};
      } else resources.billing={...resources.billing,state:'unavailable',code:'identity_or_response_invalid'};
    }
    } else resources.order={...resources.order,state:'unavailable',code:'identity_or_response_invalid'};
  }
  const associated=Array.isArray(detail.related_entities) && detail.related_entities.some((e:any)=>e === "return" || e?.type === "return");
  const ret=associated ? await optional('return',`/post-purchase/v2/claims/${encodeURIComponent(id)}/returns`,null) : null;
  let relation: Record<string,any> | null=null;
  // Identity resolution belongs to this same existing capture, not a later job.
  if(detail.resource==='shipment') {
    const path=`/shipments/${encodeURIComponent(String(detail.resource_id))}/items`;
    const items=await optional('shipment_orders',path,null);
    const valid=Array.isArray(items) && items.length>0 && items.every((x:any)=>x.order_id && String(x.sender_id)===sellerId);
    if(valid) {
      const order_ids=[...new Set(items.map((x:any)=>String(x.order_id)))].sort();
      relation={state:'verified',shipment_id:String(detail.resource_id),seller_id:sellerId,order_ids,endpoint:path};
    } else resources.shipment_orders={...resources.shipment_orders,state:'unavailable',code:'identity_or_response_invalid'};
  }
  let return_cost=null;
  if(options.financial) {
    const path=`${root}/charges/return-cost`,cost=await optional('return_cost',path,null);
    if(validReturnCost(cost)) {
      return_cost={amount:cost.amount,currency_id:cost.currency_id,claim_id:id,endpoint:path,basis:'context_only_already_represented_in_statement'};
      // Enrichment is excluded from the existing business fingerprint. Keeping
      // collection time here prevents unchanged hourly checks from queuing jobs.
      resources.return_cost.observed_at=new Date().toISOString();
    }
    else resources.return_cost={...resources.return_cost,state:'unavailable',code:'cost_unavailable_or_invalid'};
  }
  // Deliberately no available-offers request here: that resource belongs to the explicit click only.
  return {...detail,__case_enrichment:{reason,reputation,messages,actions,statuses,resolutions,buyer,return:ret,relation,return_cost,resources,
    state:Object.values(resources).some((r:any)=>r.state!=='obtained')?'partial':'complete'}};
}

// Called only by the existing worker after the rollout cutoff check, never by consolidation or a read path.
export async function enrichMercadoLivreClaim(id: string, account: MarketplaceAccountConfig) {
  const db = supabaseAdmin();
  const owner = randomUUID();
  return loadMercadoLivreClaimBundle(id, account, undefined, (order, claimAt) => recoverClaimChatHistory(account, order, claimAt, {
    acquire: async (key, at, now) => {
      await db.from("settings").upsert({ key, value: {}, description: "Cache de recuperação do chat anterior de reclamação ML" }, { onConflict: "key", ignoreDuplicates: true }).throwOnError();
      const saved = await db.from("settings").select("value,updated_at").eq("key", key).single().throwOnError();
      if (historyCacheFresh(saved.data.value || {}, at, now)) return false;
      // Compare-and-set also coalesces simultaneous claims for the same account/order across processes.
      const lease = await db.from("settings").update({ value: { owner, result: "processing", retryAt: new Date(now + 15 * 60_000).toISOString(), attemptedAt: new Date(now).toISOString() }, updated_at: new Date(now).toISOString() })
        .eq("key", key).eq("updated_at", saved.data.updated_at).eq("value", JSON.stringify(saved.data.value)).select("key").throwOnError();
      return Boolean(lease.data?.length);
    },
    finish: async (key, value) => { await db.from("settings").update({ value, updated_at: new Date().toISOString() }).eq("key", key).eq("value->>owner", owner).throwOnError(); },
    read: path => getMercadoLivrePostSaleConversation(path, account),
    persist: (remote, context) => persistMercadoLivrePostSale(remote, account, context)
  }), {financial:true});
}
export async function enrichShopeeReturn(id: string, account: ShopeeAccountConfig) {
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account));
  const result = await client.getReturnDetail(token, String(account.shop_id || account.account_id || ""), id);
  const detail = (result.response || {}) as Record<string, any>;
  if (String(detail.return_sn) !== id) throw new Error("Return retornado nao corresponde ao evento.");
  return detail;
}
