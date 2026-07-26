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
  status?: string | null;
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
  const data = await selectMarketplaceAccounts(
    "id,name,marketplace,active,shop_id,account_id,access_token,refresh_token,token_expires_at,status"
  );

  return ((data ?? []) as unknown as ShopeeAccountConfig[])
    .filter((account) => account.marketplace === "shopee")
    .filter(isConnectedAccount);
}

export async function listShopeeInventory(account: ShopeeAccountConfig): Promise<ShopeeInventoryItem[]> {
  const itemIds: string[] = [];
  let offset = 0;

  while (true) {
    const page = await listShopeeInventoryIdsPage(account, offset);
    itemIds.push(...page.itemIds);
    if (!page.hasNextPage) break;
    offset = page.nextOffset;
  }

  const items: ShopeeInventoryItem[] = [];
  for (const itemIdBatch of chunk(itemIds, 50)) {
    items.push(...await getShopeeInventoryDetails(account, itemIdBatch));
  }

  await markShopeeInventoryRead(account.id);
  return items;
}

export async function listShopeeInventoryIdsPage(account: ShopeeAccountConfig, offset = 0) {
  const shopId = account.shop_id || account.account_id;
  if (!shopId) {
    throw new Error(`Shop ID nao configurado para ${account.name}.`);
  }

  const accessToken = await getValidShopeeAccessToken(account);
  const config = await getShopeeOAuthConfig(account.id);
  const client = createShopeeClient(config);
  const list = await client.getProducts(accessToken, shopId, offset, 100);
  const itemIds = extractShopeeItemIds(list);
  const page = extractShopeePage(list);
  const nextOffset = page.nextOffset ?? offset + itemIds.length;
  if (page.hasNextPage && nextOffset <= offset) {
    throw new Error(`Paginacao Shopee invalida: offset ${offset}, proximo offset ${nextOffset}.`);
  }

  return {
    itemIds,
    hasNextPage: page.hasNextPage && itemIds.length > 0,
    nextOffset
  };
}

export async function getShopeeInventoryDetails(account: ShopeeAccountConfig, itemIds: string[]) {
  const shopId = account.shop_id || account.account_id;
  if (!shopId) {
    throw new Error(`Shop ID nao configurado para ${account.name}.`);
  }
  if (itemIds.length === 0) return [];

  const accessToken = await getValidShopeeAccessToken(account);
  const config = await getShopeeOAuthConfig(account.id);
  const client = createShopeeClient(config);
  const items: ShopeeInventoryItem[] = [];
  for (const itemIdBatch of chunk(itemIds, 50)) {
    const detail = await client.getProductsByIds(accessToken, shopId, itemIdBatch);
    for (const rawItem of extractShopeeItems(detail)) {
      const itemId = String(rawItem.item_id || "");
      const sku = extractShopeeSku(rawItem);
      if (!itemId || !sku) {
        continue;
      }
      items.push({
        accountId: account.id,
        accountName: account.name,
        marketplace: "shopee",
        listingId: itemId,
        sku,
        title: String(rawItem.item_name || rawItem.name || sku),
        price: extractShopeePrice(rawItem),
        stock: extractShopeeStock(rawItem),
        status: String(rawItem.item_status || rawItem.status || ""),
        rawData: rawItem
      });
    }
  }

  return items;
}

export async function markShopeeInventoryRead(accountId: string) {
  await supabaseAdmin()
    .from("config_marketplace_accounts")
    .update({ last_inventory_sync_at: new Date().toISOString(), last_sync_at: new Date().toISOString(), last_error: null })
    .eq("id", accountId);
}

export async function getValidShopeeAccessToken(account: ShopeeAccountConfig) {
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

function extractShopeeItems(payload: Record<string, unknown>) {
  const response = payload.response as Record<string, unknown> | undefined;
  const items = (response?.item_list || response?.item || []) as Array<Record<string, unknown>>;
  return items;
}

function extractShopeePage(payload: Record<string, unknown>) {
  const response = payload.response as Record<string, unknown> | undefined;
  const hasNextPage = response?.has_next_page === true || String(response?.has_next_page).toLowerCase() === "true";
  const numericOffset = Number(response?.next_offset);
  return {
    hasNextPage,
    nextOffset: Number.isFinite(numericOffset) ? numericOffset : undefined
  };
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

async function selectMarketplaceAccounts(columns: string) {
  let selectedColumns = columns.split(",").filter(Boolean);

  for (let attempt = 0; attempt < selectedColumns.length; attempt += 1) {
    const result = await supabaseAdmin()
      .from("config_marketplace_accounts")
      .select(selectedColumns.join(","))
      .eq("marketplace", "shopee")
      .eq("active", true)
      .order("name");

    if (!result.error) {
      return result.data ?? [];
    }

    const missingColumn = extractMissingColumn(result.error.message);
    if (!missingColumn || !selectedColumns.includes(missingColumn)) {
      throw new Error(result.error.message);
    }

    selectedColumns = selectedColumns.filter((column) => column !== missingColumn);
  }

  return [];
}

function isConnectedAccount(account: ShopeeAccountConfig) {
  if (!account.active) {
    return false;
  }

  if (account.status === "disconnected" || account.status === "inactive") {
    return false;
  }

  return Boolean(account.access_token || account.refresh_token);
}

function extractMissingColumn(message: string) {
  const patterns = [
    /column\s+[^.]+\.(\w+)\s+does not exist/i,
    /Could not find the ['"]?(\w+)['"]? column/i,
    /Could not find ['"]?(\w+)['"]? in the schema cache/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}
