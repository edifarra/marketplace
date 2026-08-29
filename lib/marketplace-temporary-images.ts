import { readImageDimensions } from "./marketplace-image-validation";
import { extractMarketplaceImageUrls } from "./marketplace-image-recovery";
import { getMercadoLivreAccountById, getMercadoLivreItem } from "./mercado-livre";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { getValidShopeeAccessToken, type ShopeeAccountConfig } from "./shopee";
import { supabaseAdmin } from "./supabase-admin";

const MAX_IMAGES = 6;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

type Marketplace = "mercado_livre" | "shopee";

export type TemporaryMarketplaceImage = {
  key: string;
  name: string;
  url: string;
  position: number;
  bytes: number;
  width: number;
  height: number;
};

export type TemporaryMarketplaceImageSet = {
  images: TemporaryMarketplaceImage[];
  marketplace: Marketplace;
  accountId: string;
  listingId: string;
  totalRemoteImages: number;
};

export async function recoverTemporaryImagesWhenCloudinaryIsUnavailable(
  productId: string,
  currentImages: Array<{ cloudinary_url?: string | null }>
): Promise<TemporaryMarketplaceImageSet | null> {
  const unavailable = currentImages.length === 0
    || (await Promise.all(currentImages.map(image => isReachableCloudinaryUrl(image.cloudinary_url)))).some(reachable => !reachable);
  if (!unavailable) return null;

  const links = await supabaseAdmin().from("product_marketplaces")
    .select("marketplace,marketplace_account_id,marketplace_product_id,raw_data,updated_at")
    .eq("product_id", productId)
    .eq("existe_no_marketplace", true)
    .not("marketplace_product_id", "is", null)
    .throwOnError();
  const ordered = [...(links.data || [])]
    .filter(link => link.marketplace === "mercado_livre" || link.marketplace === "shopee")
    .sort((left, right) => marketplacePriority(String(left.marketplace)) - marketplacePriority(String(right.marketplace))
      || String(left.updated_at || "").localeCompare(String(right.updated_at || "")));

  for (const link of ordered) {
    const marketplace = link.marketplace as Marketplace;
    const accountId = String(link.marketplace_account_id || "");
    const listingId = String(link.marketplace_product_id || "");
    if (!accountId || !listingId) continue;
    try {
      let urls = await fetchCurrentMarketplaceImageUrls(marketplace, accountId, listingId);
      if (!urls.length) urls = extractMarketplaceImageUrls((link.raw_data || {}) as Record<string, unknown>);
      if (!urls.length) continue;
      const images = await Promise.all(urls.slice(0, MAX_IMAGES).map((url, index) => inspectRemoteImage(url, index + 1)));
      return { images, marketplace, accountId, listingId, totalRemoteImages: urls.length };
    } catch {
      // Uma integracao indisponivel nao impede tentar a proxima conta vinculada.
    }
  }
  return null;
}

export async function resolveMarketplaceRecoveryImageUrls(input: {
  productId: string;
  marketplace: Marketplace;
  accountId: string;
  listingId: string;
}) {
  const link = await supabaseAdmin().from("product_marketplaces")
    .select("id")
    .eq("product_id", input.productId)
    .eq("marketplace", input.marketplace)
    .eq("marketplace_account_id", input.accountId)
    .eq("marketplace_product_id", input.listingId)
    .eq("existe_no_marketplace", true)
    .maybeSingle()
    .throwOnError();
  if (!link.data) throw new Error("A integracao usada para recuperar as fotos nao esta mais vinculada ao produto.");
  return (await fetchCurrentMarketplaceImageUrls(input.marketplace, input.accountId, input.listingId)).slice(0, MAX_IMAGES);
}

async function fetchCurrentMarketplaceImageUrls(marketplace: Marketplace, accountId: string, listingId: string) {
  if (marketplace === "mercado_livre") {
    const account = await getMercadoLivreAccountById(accountId);
    return extractMarketplaceImageUrls(await getMercadoLivreItem(listingId, account));
  }
  const accountResult = await supabaseAdmin().from("config_marketplace_accounts")
    .select("id,name,marketplace,active,shop_id,account_id,access_token,refresh_token,token_expires_at,status")
    .eq("id", accountId).single().throwOnError();
  const account = accountResult.data as ShopeeAccountConfig;
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error("Shop ID ausente para recuperar as fotos da Shopee.");
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const response = await client.getProductById(token, shopId, listingId) as Record<string, any>;
  const item = response.response?.item_list?.[0] || {};
  return extractMarketplaceImageUrls(item);
}

async function inspectRemoteImage(url: string, position: number): Promise<TemporaryMarketplaceImage> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Falha ao baixar temporariamente a foto do anuncio (${response.status}).`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_SOURCE_BYTES) throw new Error("A foto do anuncio excede 8 MB.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("A foto do anuncio excede 8 MB.");
  const dimensions = readImageDimensions(bytes);
  return { key: String(position - 1), name: `marketplace-${String(position).padStart(2, "0")}.jpg`, url,
    position, bytes: bytes.byteLength, width: dimensions.width, height: dimensions.height };
}

async function isReachableCloudinaryUrl(url: string | null | undefined) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

function marketplacePriority(marketplace: string) { return marketplace === "mercado_livre" ? 0 : 1; }
