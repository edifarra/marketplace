import { getMercadoLivreResource, MarketplaceAccountConfig } from "./mercado-livre";
import { getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";

// Called only by the existing worker after the rollout cutoff check, never by consolidation or a read path.
export async function enrichMercadoLivreClaim(id: string, account: MarketplaceAccountConfig) {
  const detail = await getMercadoLivreResource(`/post-purchase/v1/claims/${encodeURIComponent(id)}`, account);
  if (String(detail.id) !== id) throw new Error("Claim retornado nao corresponde ao evento.");
  return detail;
}
export async function enrichShopeeReturn(id: string, account: ShopeeAccountConfig) {
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account));
  const result = await client.getReturnDetail(token, String(account.shop_id || account.account_id || ""), id);
  const detail = (result.response || {}) as Record<string, any>;
  if (String(detail.return_sn) !== id) throw new Error("Return retornado nao corresponde ao evento.");
  return detail;
}
