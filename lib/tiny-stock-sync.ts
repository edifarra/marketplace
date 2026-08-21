import { randomUUID } from "crypto";
import { findTinyProductBySku, getTinyProductSnapshot, listTinyProductsPage } from "./tiny";
import { supabaseAdmin } from "./supabase-admin";
import { logSynchronizationResult } from "./synchronization-logs";
import { clearTinyLink, isTinyNotFoundError, reconcileProductIntegrationStatus } from "./product-integration-status";

type Phase = "prepare" | "listing" | "existing" | "migration" | "deletion" | "done";
type TinyProgress = {
  status: "idle" | "running" | "done" | "failed";
  phase: Phase;
  runId: string;
  page: number;
  pages: number;
  totalFiles: number;
  processedFiles: number;
  syncedProducts: number;
  migratedProducts: number;
  deletedProducts: number;
  failedProducts: number;
  percent: number;
  message: string;
  updatedAt?: string;
};

const KEY = "TINY_STOCK_SYNC_PROGRESS_V2";
const DB_BATCH = 250;
const MAX_PRODUCT_ATTEMPTS = 3;

export async function startTinyStockSync(force = false) {
  const current = await getTinyStockSyncProgress();
  if (current.status === "running" && !force) return current;
  const progress: TinyProgress = {
    status: "running", phase: "prepare", runId: randomUUID(), page: 0, pages: 0,
    totalFiles: 0, processedFiles: 0, syncedProducts: 0, migratedProducts: 0,
    deletedProducts: 0, failedProducts: 0, percent: 1,
    message: "Preparando produtos do sistema."
  };
  await save(progress);
  return progress;
}

export async function stepTinyStockSync() {
  const progress = await getTinyStockSyncProgress();
  // Um worker antigo ou atrasado nunca deve criar uma nova execucao sozinho.
  // Inicio e reinicio sao decisoes explicitas da rota/tela.
  if (progress.status !== "running") return progress;
  try {
    if (progress.phase === "prepare") return prepareSystemProducts(progress);
    if (progress.phase === "listing") return listTinyPage(progress);
    if (progress.phase === "existing") return processOne(progress, "update");
    if (progress.phase === "migration") return processOne(progress, "migrate");
    if (progress.phase === "deletion") return processOne(progress, "delete");
    return progress;
  } catch (error) {
    const failed = { ...progress, status: "failed" as const, message: errorMessage(error) };
    await save(failed);
    await logTinyResult(failed);
    return failed;
  }
}

export async function getTinyStockSyncProgress(): Promise<TinyProgress> {
  const { data } = await supabaseAdmin().from("settings").select("value").eq("key", KEY).maybeSingle();
  return (data?.value as TinyProgress) || {
    status: "idle", phase: "prepare", runId: "", page: 0, pages: 0, totalFiles: 0,
    processedFiles: 0, syncedProducts: 0, migratedProducts: 0, deletedProducts: 0,
    failedProducts: 0, percent: 0, message: "Aguardando sincronizacao."
  };
}

async function prepareSystemProducts(progress: TinyProgress) {
  const db = supabaseAdmin();
  const { data } = await db.from("products")
    .select("id,sku,tiny_product_id,sent_target,tiny_last_synced_on")
    .order("id").range(progress.processedFiles, progress.processedFiles + DB_BATCH - 1).throwOnError();
  const rows = data || [];
  if (rows.length) {
    const staged = rows.filter(row => normalizeSku(row.sku)).map(row => ({
      run_id: progress.runId, sku: normalizeSku(row.sku), product_id: row.id,
      tiny_product_id: row.tiny_product_id, action: "delete",
      status: "pending"
    }));
    if (staged.length) await db.from("tiny_sync_items").upsert(staged, { onConflict: "run_id,sku" }).throwOnError();
  }
  const next = rows.length === DB_BATCH
    ? { ...progress, processedFiles: progress.processedFiles + rows.length, message: "Preparando produtos do sistema." }
    : { ...progress, phase: "listing" as const, processedFiles: 0, message: "Listando produtos do Tiny." };
  await save(next);
  return next;
}

async function logTinyResult(progress: TinyProgress) {
  const { data: failedItems } = await supabaseAdmin().from("tiny_sync_items")
    .select("sku,error_message")
    .eq("run_id", progress.runId)
    .eq("status", "failed")
    .order("created_at")
    .throwOnError();
  await logSynchronizationResult({
    process: "Sincronismo Tiny",
    status: progress.status === "done" ? "done" : "failed",
    totals: {
      evaluated: progress.syncedProducts + progress.migratedProducts + progress.deletedProducts + progress.failedProducts,
      updated: progress.syncedProducts,
      removed: progress.deletedProducts,
      included: progress.migratedProducts
    },
    error: progress.status === "failed" ? progress.message : undefined,
    failures: (failedItems || []).map(item => ({
      sku: String(item.sku || "nao identificado"),
      reason: String(item.error_message || "Motivo nao informado")
    }))
  });
}

async function listTinyPage(progress: TinyProgress) {
  const page = progress.page + 1;
  const result = await listTinyProductsPage(page);
  const db = supabaseAdmin();
  for (const item of result.products) {
    const sku = normalizeSku(item.codigo);
    if (!sku) continue;

    const tinyProductId = String(item.id || "");
    const byTinyId = tinyProductId
      ? await db.from("tiny_sync_items")
        .select("id,sku,product_id")
        .eq("run_id", progress.runId)
        .eq("tiny_product_id", tinyProductId)
        .not("product_id", "is", null)
        .limit(1)
        .maybeSingle()
        .throwOnError()
      : { data: null };
    const bySku = byTinyId.data?.product_id
      ? { data: null }
      : await db.from("tiny_sync_items")
        .select("id,sku,product_id")
        .eq("run_id", progress.runId)
        .eq("sku", sku)
        .limit(1)
        .maybeSingle()
        .throwOnError();
    const existing = byTinyId.data || bySku.data;

    // O ID do Tiny tem precedencia sobre o SKU. Quando o SKU foi alterado no
    // Tiny, substituimos o item preparado com o SKU antigo pelo SKU atual.
    if (existing?.id && existing.sku !== sku) {
      await db.from("tiny_sync_items").delete().eq("id", existing.id).throwOnError();
    }

    await db.from("tiny_sync_items").upsert({
      run_id: progress.runId, sku, product_id: existing?.product_id || null,
      tiny_product_id: tinyProductId, tiny_data: item,
      action: existing?.product_id ? "update" : "migrate",
      status: "pending", updated_at: new Date().toISOString()
    }, { onConflict: "run_id,sku" }).throwOnError();
  }
  const done = page >= result.pages;
  let totalFiles = progress.totalFiles;
  if (done) {
    const countResult = await db.from("tiny_sync_items")
      .select("id", { count: "exact", head: true })
      .eq("run_id", progress.runId)
      .throwOnError();
    totalFiles = countResult.count || 0;
  }
  const next = { ...progress, page, pages: result.pages, phase: done ? "existing" as const : "listing" as const,
    totalFiles, processedFiles: 0, percent: Math.round((page / Math.max(1, result.pages)) * 20),
    message: done ? `0 de ${totalFiles} produtos sincronizados.` : `Listando pagina ${page} de ${result.pages} do Tiny.` };
  await save(next);
  return next;
}

async function processOne(progress: TinyProgress, action: "update" | "migrate" | "delete") {
  const db = supabaseAdmin();
  let totalFiles = progress.totalFiles;
  if (!totalFiles) {
    const countResult = await db.from("tiny_sync_items")
      .select("id", { count: "exact", head: true })
      .eq("run_id", progress.runId)
      .throwOnError();
    totalFiles = countResult.count || 0;
  }
  const { data: item } = await db.from("tiny_sync_items").select("*")
    .eq("run_id", progress.runId).eq("action", action).eq("status", "pending")
    .order("updated_at").order("created_at").limit(1).maybeSingle().throwOnError();
  if (!item) return advance(progress, action);

  let syncedProducts = progress.syncedProducts;
  let migratedProducts = progress.migratedProducts;
  let deletedProducts = progress.deletedProducts;
  let failedProducts = progress.failedProducts;
  try {
    if (action === "update") {
      let detail: Record<string, unknown>;
      let resolvedTinyProductId = String(item.tiny_product_id);
      try {
        detail = await getTinyProductSnapshot(resolvedTinyProductId) as Record<string, unknown>;
      } catch (error) {
        if (!isTinyNotFoundError(error)) throw error;
        const replacement = await findTinyProductBySku(String(item.sku));
        if (replacement?.id) {
          resolvedTinyProductId = String(replacement.id);
          detail = await getTinyProductSnapshot(resolvedTinyProductId) as Record<string, unknown>;
        } else {
        await clearTinyLink(String(item.product_id));
        await reconcileProductIntegrationStatus(String(item.product_id));
        deletedProducts++;
        await db.from("tiny_sync_items").update({ status: "done", processed_at: new Date().toISOString(), error_message: "Vinculo Tiny removido: produto nao localizado." }).eq("id", item.id).throwOnError();
        const next = { ...progress, totalFiles, processedFiles: progress.processedFiles + 1, syncedProducts, migratedProducts, deletedProducts, failedProducts,
          percent: totalFiles > 0 ? Math.min(99, 20 + Math.round(((syncedProducts + migratedProducts + deletedProducts + failedProducts) / totalFiles) * 79)) : progress.percent,
          message: progressMessage(totalFiles, syncedProducts, migratedProducts, deletedProducts, failedProducts) };
        await save(next);
        return next;
        }
      }
      const sku = normalizeSku(detail.codigo || item.sku);
      const stock = stockOf(detail);
      const price = Number(detail.preco ?? detail.preco_promocional ?? item.tiny_data?.preco ?? 0) || 0;
      const title = String(detail.nome || item.tiny_data?.nome || sku).trim();
      const description = tinyDescription(detail);
      await db.from("products").update({ sku, tiny_product_id: resolvedTinyProductId, title, description, price, stock,
        status: "sent", sent_target: "TINY", tiny_last_synced_on: today(), updated_at: new Date().toISOString() })
        .eq("id", item.product_id).throwOnError();
      await removeMismatchedMarketplaceLinks(String(item.product_id), sku);
      await updateInventory(String(item.product_id), sku, stock);
      syncedProducts++;
    } else if (action === "migrate") {
      const detail = await getTinyProductSnapshot(String(item.tiny_product_id)) as Record<string, unknown>;
      const stock = stockOf(detail);
      const inserted = await db.from("products").insert({ sku: item.sku, source_key: `TINY_${item.tiny_product_id}`,
        title: String(detail.nome || item.sku), description: tinyDescription(detail),
        price: Number(detail.preco || detail.preco_promocional || 0), stock,
        status: "sent", tiny_product_id: item.tiny_product_id, sent_target: "TINY",
        sent_at: new Date().toISOString(), tiny_last_synced_on: today() }).select("id").single().throwOnError();
      await updateInventory(inserted.data.id, item.sku, stock);
      migratedProducts++;
    } else {
      await clearTinyLink(String(item.product_id));
      await reconcileProductIntegrationStatus(String(item.product_id));
      deletedProducts++;
    }
    await db.from("tiny_sync_items").update({ status: "done", processed_at: new Date().toISOString(), error_message: null }).eq("id", item.id).throwOnError();
  } catch (error) {
    const tinyData = item.tiny_data && typeof item.tiny_data === "object" ? item.tiny_data : {};
    const attemptCount = Number(tinyData._syncAttemptCount || 0) + 1;
    const exhausted = attemptCount >= MAX_PRODUCT_ATTEMPTS;
    if (exhausted) failedProducts++;
    await db.from("tiny_sync_items").update({
      status: exhausted ? "failed" : "pending",
      tiny_data: { ...tinyData, _syncAttemptCount: attemptCount },
      processed_at: exhausted ? new Date().toISOString() : null,
      error_message: errorMessage(error),
      updated_at: new Date().toISOString()
    }).eq("id", item.id).throwOnError();
  }
  const completedAttempt = syncedProducts > progress.syncedProducts
    || migratedProducts > progress.migratedProducts
    || deletedProducts > progress.deletedProducts
    || failedProducts > progress.failedProducts;
  const next = { ...progress, totalFiles, processedFiles: progress.processedFiles + (completedAttempt ? 1 : 0), syncedProducts, migratedProducts, deletedProducts, failedProducts,
    percent: totalFiles > 0
      ? Math.min(99, 20 + Math.round(((syncedProducts + migratedProducts + deletedProducts + failedProducts) / totalFiles) * 79))
      : progress.percent,
    message: progressMessage(totalFiles, syncedProducts, migratedProducts, deletedProducts, failedProducts) };
  await save(next);
  return next;
}

async function advance(progress: TinyProgress, action: "update" | "migrate" | "delete") {
  const phase = action === "update" ? "migration" : action === "migrate" ? "deletion" : "done";
  const done = phase === "done";
  const next: TinyProgress = { ...progress, phase, status: done ? "done" : "running", processedFiles: 0,
    percent: action === "update" ? 55 : action === "migrate" ? 85 : 100,
    totalFiles: progress.syncedProducts + progress.migratedProducts + progress.deletedProducts + progress.failedProducts,
    message: done
      ? `${progress.syncedProducts} atualizados, ${progress.migratedProducts} incluidos, ${progress.deletedProducts} excluidos, ${progress.failedProducts} com erro.`
      : action === "update" ? "Incluindo produtos novos." : "Excluindo produtos ausentes no Tiny." };
  await save(next);
  if (done) {
    await logTinyResult(next);
  }
  return next;
}

async function updateInventory(productId: string, sku: string, stock: number) {
  const db = supabaseAdmin();
  await db.from("estoque").upsert({ product_id: productId, sku }, { onConflict: "product_id" }).throwOnError();
  await db.rpc("set_physical_inventory", { p_product_id: productId, p_quantity: stock }).throwOnError();
}

async function removeMismatchedMarketplaceLinks(productId: string, sku: string) {
  const db = supabaseAdmin();
  const [marketplaceRows, listingRows] = await Promise.all([
    db.from("product_marketplaces")
      .select("id,sku")
      .eq("product_id", productId)
      .throwOnError(),
    db.from("listings")
      .select("id,external_sku")
      .eq("product_id", productId)
      .throwOnError()
  ]);
  const marketplaceIds = (marketplaceRows.data || [])
    .filter(row => normalizeSku(row.sku) !== sku)
    .map(row => row.id);
  const listingIds = (listingRows.data || [])
    .filter(row => normalizeSku(row.external_sku) !== sku)
    .map(row => row.id);

  if (marketplaceIds.length) {
    await db.from("product_marketplaces").delete().in("id", marketplaceIds).throwOnError();
  }
  if (listingIds.length) {
    await db.from("listings").delete().in("id", listingIds).throwOnError();
  }
}

async function save(progress: TinyProgress) {
  const savedProgress = { ...progress, updatedAt: new Date().toISOString() };
  await supabaseAdmin().from("settings").upsert({ key: KEY, value: savedProgress,
    description: "[ESTOQUE] Progresso da sincronizacao incremental Tiny", updated_at: new Date().toISOString() }, { onConflict: "key" }).throwOnError();
}

function normalizeSku(value: unknown) { return String(value || "").trim().toUpperCase(); }
function stockOf(value: Record<string, unknown>) { return Math.max(0, Math.trunc(Number(value.saldo ?? value.estoque_atual ?? 0) || 0)); }
function tinyDescription(value: Record<string, unknown>) {
  return String(value.descricao_complementar ?? value.descricao ?? value.obs ?? "").trim() || null;
}
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function progressMessage(total: number, updated: number, migrated: number, deleted: number, failed: number) {
  const processed = updated + migrated + deleted + failed;
  return `${processed} de ${Math.max(total, processed)} produtos sincronizados${failed ? ` (${failed} com erro)` : ""}.`;
}
