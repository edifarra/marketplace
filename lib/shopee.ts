import { refreshMarketplaceAccountToken } from "./marketplace-token-refresh";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { supabaseAdmin } from "./supabase-admin";

export type ShopeeAccountConfig = {
  id: string;
  name: string;
  marketplace: string;
  active: boolean;
  shop_id?: string | null;
  account_id?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
};

export type ShopeeInventoryItem = {
  accountId: string;
  accountName: string;
  marketplace: "shopee";
  listingId: string;
  sku: string;
  title: string;
  price: number;
  stock: number;
  status: string;
  rawData: Record<string, unknown>;
};

export async function getActiveShopeeAccounts() {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id,name,marketplace,active,shop_id,account_id,access_token,refresh_token,token_expires_at")
    .eq("marketplace", "shopee")
    .eq("active", true)
    .order("name")
    .throwOnError();

  return (data ?? []) as ShopeeAccountConfig[];
}

export async function listShopeeInventory(account: ShopeeAccountConfig): Promise<ShopeeInventoryItem[]> {
  const shopId = account.shop_id || account.account_id;
  if (!shopId) {
    throw new Error(`Shop ID nao configurado para ${account.name}.`);
  }

  const accessToken = await getValidShopeeAccessToken(account);
  const config = await getShopeeOAuthConfig(account.id);
  const client = createShopeeClient(config);
  const list = await client.getProducts(accessToken, shopId);
  const itemIds = extractShopeeItemIds(list);
  const items: ShopeeInventoryItem[] = [];

  for (const itemId of itemIds) {
    const detail = await client.getProductById(accessToken, shopId, itemId);
    const rawItem = extractFirstShopeeItem(detail);
    const sku = extractShopeeSku(rawItem);
    if (!sku) {
      continue;
    }
    items.push({
      accountId: account.id,
      accountName: account.name,
      marketplace: "shopee",
      listingId: String(itemId),
      sku,
      title: String(rawItem.item_name || rawItem.name || sku),
      price: extractShopeePrice(rawItem),
      stock: extractShopeeStock(rawItem),
      status: String(rawItem.item_status || rawItem.status || ""),
      rawData: rawItem
    });
  }

  await supabaseAdmin()
    .from("config_marketplace_accounts")
    .update({ last_inventory_sync_at: new Date().toISOString(), last_sync_at: new Date().toISOString(), last_error: null })
    .eq("id", account.id);

  return items;
}

async function getValidShopeeAccessToken(account: ShopeeAccountConfig) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expiresAt > Date.now() + 60_000) {
    return account.access_token;
  }
  if (!account.refresh_token) {
    if (account.access_token) {
      return account.access_token;
    }
    throw new Error(`Token OAuth incompleto para ${account.name}. Clique em Conectar Shopee nessa conta.`);
  }

  return refreshMarketplaceAccountToken(account.id);
}

function extractShopeeItemIds(payload: Record<string, unknown>) {
  const response = payload.response as Record<string, unknown> | undefined;
  const items = (response?.item || response?.item_list || []) as Array<Record<string, unknown>>;
  return items.map((item) => String(item.item_id || "")).filter(Boolean);
}

function extractFirstShopeeItem(payload: Record<string, unknown>) {
  const response = payload.response as Record<string, unknown> | undefined;
  const items = (response?.item_list || response?.item || []) as Array<Record<string, unknown>>;
  return items[0] || response || payload;
}

function extractShopeeSku(item: Record<string, unknown>) {
  return String(item.item_sku || item.seller_sku || item.sku || "").trim();
}

function extractShopeePrice(item: Record<string, unknown>) {
  const priceInfo = item.price_info as Array<Record<string, unknown>> | undefined;
  return Number(priceInfo?.[0]?.current_price || item.price || 0);
}

function extractShopeeStock(item: Record<string, unknown>) {
  const stockInfo = item.stock_info_v2 as Record<string, unknown> | undefined;
  const summary = stockInfo?.summary_info as Record<string, unknown> | undefined;
  return Number(summary?.total_available_stock || item.stock || 0);
}
