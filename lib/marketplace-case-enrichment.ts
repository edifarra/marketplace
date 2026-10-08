import { getValidMercadoLivreAccessToken, mlGet, MarketplaceAccountConfig } from "./mercado-livre";
import { getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { claimBuyerId, claimSeller } from "./marketplace-claim-domain";

export async function loadMercadoLivreClaimBundle(id: string, account: MarketplaceAccountConfig,
  get?: (path: string) => Promise<Record<string, any>>) {
  let token: Promise<string> | undefined;
  const read = get || (async (path: string) => mlGet(path, await (token ||= getValidMercadoLivreAccessToken(account)), {}, AbortSignal.timeout(20_000)));
  const root = `/post-purchase/v1/claims/${encodeURIComponent(id)}`;
  const detail = await read(root);
  if (String(detail.id) !== id) throw new Error("Claim retornado não corresponde ao evento.");
  const [reason,reputation,messages,actions,statuses,resolutions] = await Promise.all([
    detail.reason_id ? read(`/post-purchase/v1/claims/reasons/${encodeURIComponent(detail.reason_id)}`) : Promise.resolve({}),
    read(`${root}/affects-reputation`),read(`${root}/messages`),read(`${root}/actions-history`),read(`${root}/status-history`),read(`${root}/expected-resolutions`)
  ]);
  const sellerId=String(account.seller_id || account.account_id || "");
  const buyerId=claimBuyerId(detail);
  let buyer: Record<string,any> | null=null;
  if(detail.resource === "order" && buyerId && claimSeller(detail,sellerId)) {
    const order=await read(`/orders/${encodeURIComponent(String(detail.resource_id))}`);
    if(String(order.id)!==String(detail.resource_id) || String(order.seller?.id)!==sellerId || String(order.buyer?.id)!==buyerId) throw new Error("Identidade do pedido diverge do claim.");
    buyer={id:buyerId,site_id:detail.site_id,nickname:order.buyer.nickname || null,
      display_name:[order.buyer.first_name,order.buyer.last_name].filter(Boolean).join(" ") || order.buyer.nickname || null,
      billing_info_id:order.buyer.billing_info?.id || null,products:(order.order_items || []).map((i:any)=>({title:i.item?.title,quantity:i.quantity,amount:i.unit_price})),
      order_amount:order.total_amount,paid_amount:order.paid_amount,currency:order.currency_id};
    if(buyer.billing_info_id && detail.site_id) {
      const billing=await read(`/orders/billing-info/${encodeURIComponent(detail.site_id)}/${encodeURIComponent(buyer.billing_info_id)}`);
      if(String(billing.buyer?.cust_id)!==buyerId || String(billing.seller?.cust_id)!==sellerId) throw new Error("Identidade fiscal diverge do pedido.");
      const b=billing.buyer.billing_info || {};
      buyer={...buyer,legal_name:b.name || null,document_type:b.identification?.type || null,document_number:b.identification?.number || null,
        fiscal_address:b.address || null,customer_type:b.attributes?.cust_type || null,taxpayer_type:b.taxes?.taxpayer_type?.description || null};
    }
  }
  const associated=Array.isArray(detail.related_entities) && detail.related_entities.some((e:any)=>e === "return" || e?.type === "return");
  const ret=associated ? await read(`/post-purchase/v2/claims/${encodeURIComponent(id)}/returns`) : null;
  // Deliberately no available-offers request here: that resource belongs to the explicit click only.
  return {...detail,__case_enrichment:{reason,reputation,messages,actions,statuses,resolutions,buyer,return:ret}};
}

// Called only by the existing worker after the rollout cutoff check, never by consolidation or a read path.
export async function enrichMercadoLivreClaim(id: string, account: MarketplaceAccountConfig) {
  return loadMercadoLivreClaimBundle(id,account);
}
export async function enrichShopeeReturn(id: string, account: ShopeeAccountConfig) {
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account));
  const result = await client.getReturnDetail(token, String(account.shop_id || account.account_id || ""), id);
  const detail = (result.response || {}) as Record<string, any>;
  if (String(detail.return_sn) !== id) throw new Error("Return retornado nao corresponde ao evento.");
  return detail;
}
