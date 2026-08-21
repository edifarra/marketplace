import {
  extractSku,
  getMercadoLivreAccountById,
  getValidMercadoLivreAccessToken,
  isMercadoLivreInactive,
  mlGet
} from "./mercado-livre";
import { getShopeeInventoryDetails, listShopeeInventoryIdsPage } from "./shopee";
import { upsertMarketplaceItem } from "./migration-stock";
import { listMarketplaceAccountRows, updateMarketplaceAccountColumns } from "./marketplace-accounts-view";
import { supabaseAdmin } from "./supabase-admin";
import { randomUUID } from "crypto";
import { logSynchronizationResult } from "./synchronization-logs";
import { reconcileProductIntegrationStatus } from "./product-integration-status";

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
  runId: string;
  updatedListings: number;
  includedListings: number;
  deletedListings: number;
  linkedListings: number;
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
    message: "Sincronizacao iniciada.",
    runId: randomUUID(),
    updatedListings: 0,
    includedListings: 0,
    deletedListings: 0,
    linkedListings: 0
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
    message: "Aguardando sincronizacao.",
    runId: "",
    updatedListings: 0,
    includedListings: 0,
    deletedListings: 0,
    linkedListings: 0
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
      phase: nextScrollId ? "listing" : "details",
      status: "running",
      message: nextScrollId ? "Listando anuncios." : itemIds.length > 0 ? "Anuncios listados." : "Nenhum anuncio encontrado; conferindo exclusoes."
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
  let updatedListings = progress.updatedListings;
  let includedListings = progress.includedListings;
  let linkedListings = progress.linkedListings;

  for (const entry of details) {
    if (entry.code && entry.code >= 400) {
      throw new Error(`Mercado Livre recusou a consulta de um lote de anuncios (HTTP ${entry.code}).`);
    }

    const item = entry.body;
    if (!item) {
      throw new Error("Mercado Livre retornou um anuncio sem detalhes.");
    }

    const sku = extractSku(item);
    if (!sku) {
      const listingId = String(item.id || "");
      if (listingId) {
        const seen = await supabaseAdmin().from("product_marketplaces")
          .update({ last_seen_run_id: progress.runId, updated_at: new Date().toISOString() })
          .eq("marketplace_account_id", accountId)
          .eq("marketplace_product_id", listingId)
          .select("id");
        if (seen.error) throw new Error(seen.error.message);
        if ((seen.data || []).length) updatedListings += 1;
      }
      continue;
    }

    const normalizedSku = normalizeSku(sku);
    const db = supabaseAdmin();
    const [existingLink, systemProduct] = await Promise.all([
      db.from("product_marketplaces").select("id").eq("marketplace_account_id", accountId).eq("marketplace_product_id", String(item.id || "")).maybeSingle().throwOnError(),
      db.from("products").select("id").ilike("sku", normalizedSku).maybeSingle().throwOnError()
    ]);
    await upsertMarketplaceItem({
      accountId,
      marketplace: "mercado_livre",
      listingId: String(item.id || ""),
      sku: normalizedSku,
      title: String(item.title || ""),
      price: Number(item.price || 0),
      stock: isMercadoLivreInactive(String(item.status || "")) ? 0 : Number(item.available_quantity || 0),
      status: String(item.status || ""),
      rawData: item,
      syncRunId: progress.runId
    });
    if (existingLink.data?.id) updatedListings += 1;
    else includedListings += 1;
    if (systemProduct.data?.id) linkedListings += 1;
    syncedProducts += 1;
  }

  const processedFiles = Math.min(progress.totalFiles, progress.processedFiles + batch.length);
  const nextProgress: StockSyncProgress = {
    ...progress,
    phase: "details",
    processedFiles,
    syncedProducts,
    percent: progress.totalFiles > 0 ? Math.round(20 + (processedFiles / progress.totalFiles) * 80) : 100,
    message: `${processedFiles} de ${progress.totalFiles} produtos sincronizados.`,
    updatedListings,
    includedListings,
    linkedListings
  };

  if (processedFiles >= progress.totalFiles) {
    return finishProgress(nextProgress);
  }

  await saveProgress(nextProgress);
  return nextProgress;
}

async function syncShopeeAccount(accountId: string, progress: StockSyncProgress) {
  const account = await getMarketplaceAccount(accountId);
  const shopeeAccount = {
    id: String(account.id),
    name: String(account.name),
    marketplace: String(account.marketplace),
    active: Boolean(account.active),
    shop_id: account.shop_id ? String(account.shop_id) : null,
    account_id: account.account_id ? String(account.account_id) : null,
    access_token: account.access_token ? String(account.access_token) : null,
    refresh_token: account.refresh_token ? String(account.refresh_token) : null,
    token_expires_at: account.token_expires_at ? String(account.token_expires_at) : null
  };

  if (progress.phase === "listing") {
    const offset = Number(progress.scrollId || 0);
    const page = await listShopeeInventoryIdsPage(shopeeAccount, offset);
    const itemIds = [...new Set([...progress.itemIds, ...page.itemIds])];
    const nextProgress: StockSyncProgress = {
      ...progress,
      itemIds,
      scrollId: page.hasNextPage ? String(page.nextOffset) : "",
      totalFiles: itemIds.length,
      phase: page.hasNextPage ? "listing" : "details",
      percent: page.hasNextPage ? Math.min(19, Math.max(1, Math.round(itemIds.length / 100))) : itemIds.length ? 20 : 100,
      message: page.hasNextPage
        ? `${itemIds.length} anuncios Shopee listados.`
        : itemIds.length
          ? `${itemIds.length} anuncios Shopee encontrados.`
          : "Nenhum anuncio Shopee encontrado."
    };
    if (!page.hasNextPage && itemIds.length === 0) return finishProgress(nextProgress);
    await saveProgress(nextProgress);
    return nextProgress;
  }

  const batch = progress.itemIds.slice(progress.processedFiles, progress.processedFiles + DETAILS_BATCH_SIZE);
  if (batch.length === 0) return finishProgress(progress);
  const items = await getShopeeInventoryDetails(shopeeAccount, batch);

  let syncedProducts = progress.syncedProducts;
  let updatedListings = progress.updatedListings;
  let includedListings = progress.includedListings;
  let linkedListings = progress.linkedListings;
  for (const item of items) {
    const db = supabaseAdmin();
    const [existing, systemProduct] = await Promise.all([
      db.from("product_marketplaces").select("id").eq("marketplace_account_id", accountId).eq("marketplace_product_id", item.listingId).maybeSingle().throwOnError(),
      db.from("products").select("id").ilike("sku", normalizeSku(item.sku)).maybeSingle().throwOnError()
    ]);
    await upsertMarketplaceItem({ ...item, sku: normalizeSku(item.sku), syncRunId: progress.runId });
    if (existing.data?.id) updatedListings += 1;
    else includedListings += 1;
    if (systemProduct.data?.id) linkedListings += 1;
    syncedProducts += 1;
  }

  const processedFiles = Math.min(progress.totalFiles, progress.processedFiles + batch.length);
  const nextProgress: StockSyncProgress = {
    ...progress,
    phase: "details",
    processedFiles,
    syncedProducts,
    updatedListings,
    includedListings,
    linkedListings,
    percent: progress.totalFiles ? Math.round(20 + (processedFiles / progress.totalFiles) * 80) : 100,
    message: `${processedFiles} de ${progress.totalFiles} anuncios Shopee processados.`
  };
  if (processedFiles >= progress.totalFiles) return finishProgress(nextProgress);
  await saveProgress(nextProgress);
  return nextProgress;
}

async function finishProgress(progress: StockSyncProgress) {
  let deletedListings = progress.deletedListings;
  if (progress.runId) {
    deletedListings += await deleteListingsNotSeenInRun(progress.accountId, progress.runId, progress.itemIds);
  }
  const finished: StockSyncProgress = {
    ...progress,
    status: "done",
    phase: "done",
    percent: 100,
    deletedListings,
    message: `${progress.updatedListings} atualizados, ${progress.includedListings} incluidos, ${deletedListings} excluidos e ${progress.linkedListings} vinculados por SKU.`
  };
  await updateMarketplaceAccountColumns(progress.accountId, {
    last_inventory_sync_at: new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    status: "active",
    last_error: null
  });
  await saveProgress(finished);
  await logSynchronizationResult({
    process: `Sincronismo ${progress.accountName || marketplaceLabel(progress.marketplace)}`,
    status: "done",
    totals: {
      evaluated: progress.totalFiles,
      updated: progress.updatedListings,
      removed: deletedListings,
      included: progress.includedListings
    }
  });
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
  await logSynchronizationResult({
    process: `Sincronismo ${progress.accountName || marketplaceLabel(progress.marketplace)}`,
    status: "failed",
    totals: {
      evaluated: progress.processedFiles,
      updated: progress.updatedListings,
      removed: progress.deletedListings,
      included: progress.includedListings
    },
    error
  });
  return failed;
}

function marketplaceLabel(marketplace: string) {
  return marketplace === "shopee" ? "Shopee" : marketplace === "mercado_livre" ? "Mercado Livre" : marketplace;
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

async function deleteListingsNotSeenInRun(accountId: string, runId: string, currentListingIds: string[]) {
  const db = supabaseAdmin();
  const [marketplaceResult, listingResult] = await Promise.all([
    db.from("product_marketplaces").select("id,marketplace_product_id,product_id")
      .eq("marketplace_account_id", accountId)
      .or(`last_seen_run_id.is.null,last_seen_run_id.neq.${runId}`).throwOnError(),
    db.from("listings").select("id,external_listing_id,product_id")
      .eq("marketplace_account_id", accountId).throwOnError()
  ]);
  const stale = marketplaceResult.data || [];
  const currentIds = new Set(currentListingIds.map(String));
  const staleLegacyListings = (listingResult.data || []).filter(row => !currentIds.has(String(row.external_listing_id || "")));
  const affectedProductIds = [...new Set([
    ...stale.map(row => row.product_id ? String(row.product_id) : ""),
    ...staleLegacyListings.map(row => row.product_id ? String(row.product_id) : "")
  ].filter(Boolean))];
  for (let index = 0; index < stale.length; index += 200) {
    const batch = stale.slice(index, index + 200);
    const externalIds = batch.map(row => row.marketplace_product_id).filter(Boolean);
    if (externalIds.length) {
      await db.from("listings").delete().eq("marketplace_account_id", accountId).in("external_listing_id", externalIds).throwOnError();
    }
    await db.from("product_marketplaces").delete().in("id", batch.map(row => row.id)).throwOnError();
  }
  if (staleLegacyListings.length) {
    await db.from("listings").delete().in("id", staleLegacyListings.map(row => row.id)).throwOnError();
  }
  for (const productId of affectedProductIds) await reconcileProductIntegrationStatus(productId);
  return new Set([...stale.map(row => String(row.marketplace_product_id)), ...staleLegacyListings.map(row => String(row.external_listing_id))]).size;
}

function normalizeSku(value: unknown) {
  return String(value || "").trim().toUpperCase();
}
