import {
  extractSku,
  getMercadoLivreAccountById,
  getValidMercadoLivreAccessToken,
  isMercadoLivreInactive,
  mlGet
} from "./mercado-livre";
import { listShopeeInventory } from "./shopee";
import { upsertMarketplaceItem } from "./migration-stock";
import { listMarketplaceAccountRows, updateMarketplaceAccountColumns } from "./marketplace-accounts-view";
import { supabaseAdmin } from "./supabase-admin";

type StockSyncProgress = {
  status: "idle" | "running" | "done" | "failed";
  accountId: string;
  marketplace: string;
  accountName: string;
  phase: "idle" | "listing" | "details" | "done";
  totalFiles: number;
  processedFiles: number;
  syncedProducts: number;
  percent: number;
  itemIds: string[];
  scrollId: string;
  message: string;
  error?: string;
};

const DETAILS_BATCH_SIZE = 20;

export async function startMarketplaceStockSync(accountId: string) {
  const account = await getMarketplaceAccount(accountId);
  const progress: StockSyncProgress = {
    status: "running",
    accountId,
    marketplace: String(account.marketplace || ""),
    accountName: String(account.name || ""),
    phase: "listing",
    totalFiles: 0,
    processedFiles: 0,
    syncedProducts: 0,
    percent: 0,
    itemIds: [],
    scrollId: "",
    message: "Sincronizacao iniciada."
  };

  await saveProgress(progress);
  return progress;
}

export async function stepMarketplaceStockSync(accountId: string) {
  const account = await getMarketplaceAccount(accountId);
  const current = await getMarketplaceStockSyncProgress(accountId);

  if (current.status !== "running") {
    return startMarketplaceStockSync(accountId);
  }

  try {
    if (account.marketplace === "mercado_livre") {
      return await stepMercadoLivreSync(accountId, current);
    }

    if (account.marketplace === "shopee") {
      return await syncShopeeAccount(accountId, current);
    }

    return await failProgress(current, "Marketplace nao suportado para sincronizacao.");
  } catch (error) {
    return failProgress(current, error instanceof Error ? error.message : String(error));
  }
}

export async function getMarketplaceStockSyncProgress(accountId: string): Promise<StockSyncProgress> {
  const { data } = await supabaseAdmin()
    .from("settings")
    .select("value")
    .eq("key", progressKey(accountId))
    .maybeSingle();

  return (data?.value as StockSyncProgress | null) || {
    status: "idle",
    accountId,
    marketplace: "",
    accountName: "",
    phase: "idle",
    totalFiles: 0,
    processedFiles: 0,
    syncedProducts: 0,
    percent: 0,
    itemIds: [],
    scrollId: "",
    message: "Aguardando sincronizacao."
  };
}

async function stepMercadoLivreSync(accountId: string, progress: StockSyncProgress) {
  const account = await getMercadoLivreAccountById(accountId);
  const accessToken = await getValidMercadoLivreAccessToken(account);
  const sellerId = account.seller_id || account.account_id;

  if (!sellerId) {
    return failProgress(progress, `Seller/User ID nao configurado para ${account.name}.`);
  }

  if (progress.phase === "listing") {
    const params = new URLSearchParams({
      search_type: "scan",
      limit: "100"
    });

    if (progress.scrollId) {
      params.set("scroll_id", progress.scrollId);
    }

    const json = await mlGet(`/users/${sellerId}/items/search?${params.toString()}`, accessToken);
    const itemIds = [...progress.itemIds, ...((json.results || []) as string[])];
    const nextScrollId = String(json.scroll_id || "");
    const nextProgress: StockSyncProgress = {
      ...progress,
      itemIds,
      scrollId: nextScrollId,
      totalFiles: itemIds.length,
      percent: nextScrollId ? 10 : itemIds.length > 0 ? 20 : 100,
      phase: nextScrollId ? "listing" : itemIds.length > 0 ? "details" : "done",
      status: nextScrollId || itemIds.length > 0 ? "running" : "done",
      message: nextScrollId ? "Listando anuncios." : itemIds.length > 0 ? "Anuncios listados." : "0 produtos sincronizados."
    };

    await saveProgress(nextProgress);
    return nextProgress;
  }

  const batch = progress.itemIds.slice(progress.processedFiles, progress.processedFiles + DETAILS_BATCH_SIZE);
  if (batch.length === 0) {
    return finishProgress(progress);
  }

  const params = new URLSearchParams({
    ids: batch.join(","),
    attributes: "id,title,price,available_quantity,status,seller_custom_field,attributes,variations"
  });
  const details = await mlGet(`/items?${params.toString()}`, accessToken) as Array<{ code?: number; body?: Record<string, unknown> }>;
  let syncedProducts = progress.syncedProducts;

  for (const entry of details) {
    if (entry.code && entry.code >= 400) {
      continue;
    }

    const item = entry.body;
    if (!item) {
      continue;
    }

    const sku = extractSku(item);
    if (!sku) {
      continue;
    }

    await upsertMarketplaceItem({
      accountId,
      marketplace: "mercado_livre",
      listingId: String(item.id || ""),
      sku,
      title: String(item.title || ""),
      price: Number(item.price || 0),
      stock: isMercadoLivreInactive(String(item.status || "")) ? 0 : Number(item.available_quantity || 0),
      status: String(item.status || ""),
      rawData: item
    });
    syncedProducts += 1;
  }

  const processedFiles = Math.min(progress.totalFiles, progress.processedFiles + batch.length);
  const nextProgress: StockSyncProgress = {
    ...progress,
    phase: "details",
    processedFiles,
    syncedProducts,
    percent: progress.totalFiles > 0 ? Math.round(20 + (processedFiles / progress.totalFiles) * 80) : 100,
    message: "Sincronizando anuncios."
  };

  if (processedFiles >= progress.totalFiles) {
    return finishProgress(nextProgress);
  }

  await saveProgress(nextProgress);
  return nextProgress;
}

async function syncShopeeAccount(accountId: string, progress: StockSyncProgress) {
  const account = await getMarketplaceAccount(accountId);
  const items = await listShopeeInventory({
    id: String(account.id),
    name: String(account.name),
    marketplace: String(account.marketplace),
    active: Boolean(account.active),
    shop_id: account.shop_id ? String(account.shop_id) : null,
    account_id: account.account_id ? String(account.account_id) : null,
    access_token: account.access_token ? String(account.access_token) : null,
    refresh_token: account.refresh_token ? String(account.refresh_token) : null,
    token_expires_at: account.token_expires_at ? String(account.token_expires_at) : null
  });

  let syncedProducts = 0;
  for (const item of items) {
    await upsertMarketplaceItem(item);
    syncedProducts += 1;
  }

  return finishProgress({
    ...progress,
    totalFiles: items.length,
    processedFiles: items.length,
    syncedProducts,
    percent: 100
  });
}

async function finishProgress(progress: StockSyncProgress) {
  const finished: StockSyncProgress = {
    ...progress,
    status: "done",
    phase: "done",
    percent: 100,
    message: `${progress.syncedProducts} produtos sincronizados.`
  };
  await updateMarketplaceAccountColumns(progress.accountId, {
    last_inventory_sync_at: new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    status: "active",
    last_error: null
  });
  await saveProgress(finished);
  return finished;
}

async function failProgress(progress: StockSyncProgress, error: string) {
  const failed: StockSyncProgress = {
    ...progress,
    status: "failed",
    message: error,
    error
  };
  await updateMarketplaceAccountColumns(progress.accountId, { last_error: error });
  await saveProgress(failed);
  return failed;
}

async function getMarketplaceAccount(accountId: string) {
  const accounts = await listMarketplaceAccountRows();
  const account = accounts.find((row) => String(row.id) === accountId);
  if (!account) {
    throw new Error("Conta de marketplace nao encontrada.");
  }

  return account;
}

async function saveProgress(progress: StockSyncProgress) {
  await supabaseAdmin().from("settings").upsert({
    key: progressKey(progress.accountId),
    value: {
      ...progress,
      updatedAt: new Date().toISOString()
    },
    description: "[ESTOQUE] Progresso de sincronizacao de marketplace"
  });
}

function progressKey(accountId: string) {
  return `MARKETPLACE_STOCK_SYNC_${accountId}`;
}
