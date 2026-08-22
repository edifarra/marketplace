import { supabaseAdmin } from "./supabase-admin";
import { publishProductDirectly } from "./direct-marketplace-publisher";
import { drainOutgoingActivities, enqueueOutgoingActivity } from "./outgoing-activities";

type SendResult = {
  ok: boolean;
  productId: string;
  message: string;
  activityIds?: string[];
};

type BatchSendResult = {
  total: number;
  sent: number;
  failed: number;
  results: SendResult[];
  finishedAt: string;
};

export type BatchSendProgress = {
  status: string;
  totalFiles: number;
  processedFiles: number;
  percent: number;
  sent: number;
  failed: number;
  message?: string;
};

export const PENDING_PRODUCT_STATUSES = ["draft", "ready", "publishing"];
export const AWAITING_SEND_PRODUCT_STATUSES = [...PENDING_PRODUCT_STATUSES, "pending_price", "manual_price"];

export async function sendProductToConfiguredTarget(productId: string): Promise<SendResult> {
  const supabase = supabaseAdmin();
  const [productStatus, inventory] = await Promise.all([
    supabase.from("products").select("status").eq("id", productId).single().throwOnError(),
    supabase.from("estoque").select("estoque_disponivel").eq("product_id", productId).maybeSingle().throwOnError()
  ]);
  if (["pending_price", "manual_price"].includes(productStatus.data.status)) {
    return { ok: false, productId, message: "Produto pendente de preço. Processe ou informe o preço antes do envio." };
  }
  if (Number(inventory.data?.estoque_disponivel || 0) <= 0) {
    return { ok: false, productId, message: "Estoque disponível deve ser maior que zero para enviar o produto." };
  }
  const target = await getProductSendTarget();

  if (target === "MARKETPLACE_DIRETO") {
    const hasMarketplace = await hasActiveMarketplace();
    if (!hasMarketplace) {
      return { ok: false, productId, message: "Nenhum MarketPlace configurado." };
    }

    const results = await publishProductDirectly(productId, false);
    return { ok: true, productId, activityIds: results.map(item => String(item.id)), message: results.length
      ? `${results.length} anuncio(s) enviado(s) para a fila das lojas faltantes.`
      : "Nenhuma loja faltante para este produto." };
  }

  const existingTinyId = await getProductTinyId(productId);
  if (existingTinyId) {
    return { ok: false, productId, message: "Produto ja vinculado ao Tiny. Use Salvar para enviar atualizacoes." };
  }
  const product = await supabase.from("products").select("sku,title").eq("id", productId).single().throwOnError();
  const activityId = await enqueueOutgoingActivity({ destination: "tiny", activityType: "listing_create", productId,
    sku: String(product.data.sku), productName: String(product.data.title), requestedData: { useCurrentProductData: true },
    sourceType: "product_send", sourceId: productId });
  return { ok: true, productId, activityIds: [activityId], message: "Produto enviado para a fila do Tiny." };
}

export async function removeProductIntegration(productId: string, integration: string, deleteExternal: boolean, externalId = "", accountId = ""): Promise<SendResult> {
  if (integration === "MERCADO_LIVRE" || integration === "SHOPEE") {
    if (!externalId || !accountId) return { ok: false, productId, message: "Anuncio ou conta do Mercado Livre nao informados." };
    if (deleteExternal) {
      const product = await supabaseAdmin().from("products").select("sku,title").eq("id", productId).single().throwOnError();
      const destination = integration === "MERCADO_LIVRE" ? "mercado_livre" : "shopee";
      const activityId = await enqueueOutgoingActivity({ destination, activityType: "listing_delete", productId,
        sku: product.data.sku, productName: product.data.title, accountId, listingId: externalId, previousData: { status: "active" },
        requestedData: { status: "deleted" }, sourceType: "product_integration_removal", sourceId: productId });
      await drainOutgoingActivities();
      const result = await supabaseAdmin().from("outgoing_marketplace_activities").select("status,processing_error").eq("id", activityId).single().throwOnError();
      if (result.data.status !== "completed") throw new Error(result.data.processing_error || `Exclusao nao confirmada pela ${integration}.`);
    }
    const db = supabaseAdmin();
    await db.from("product_marketplaces")
      .update({ existe_no_marketplace: false, status_anuncio: deleteExternal ? "deleted" : "unlinked", updated_at: new Date().toISOString() })
      .eq("product_id", productId).eq("marketplace_account_id", accountId).eq("marketplace_product_id", externalId).throwOnError();
    // The detail screen and stock synchronization also read from `listings`.
    // Keeping this row made an internally removed integration remain visible
    // and eligible for later stock updates.
    await db.from("listings").delete()
      .eq("product_id", productId).eq("marketplace_account_id", accountId).eq("external_listing_id", externalId).throwOnError();
    return { ok: true, productId, message: deleteExternal ? "Anuncio excluido e vinculo removido." : "Vinculo removido apenas do sistema." };
  }
  if (integration !== "TINY") {
    return { ok: false, productId, message: "Integracao nao suportada para exclusao." };
  }

  const tinyProductId = await getProductTinyId(productId);
  if (deleteExternal && !tinyProductId) {
    return {
      ok: false,
      productId,
      message: "Nao foi possivel inativar no Tiny: produto sem codigo de vinculacao Tiny."
    };
  }

  if (deleteExternal && tinyProductId) {
    const product = await supabaseAdmin().from("products").select("sku,title").eq("id", productId).single().throwOnError();
    const activityId = await enqueueOutgoingActivity({ destination: "tiny", activityType: "listing_delete", productId,
      sku: product.data.sku, productName: product.data.title, listingId: tinyProductId, previousData: { status: "active" },
      requestedData: { status: "inactive" }, sourceType: "product_integration_removal", sourceId: productId });
    await drainOutgoingActivities();
    const result = await supabaseAdmin().from("outgoing_marketplace_activities").select("status,processing_error,confirmed_data").eq("id", activityId).single().throwOnError();
    if (result.data.status !== "completed") throw new Error(result.data.processing_error || "Inativacao nao confirmada pelo Tiny.");
    await supabaseAdmin().from("settings").upsert({ key: `TINY_LAST_DEACTIVATE_PRODUCT_${productId}`,
      value: result.data.confirmed_data, description: "[TINY] Ultimo retorno de inativacao do produto" });
  }

  await clearTinyIntegration(productId);
  return {
    ok: true,
    productId,
    message: deleteExternal && tinyProductId
      ? "Produto inativado no Tiny e vinculo removido do sistema."
      : "Vinculo Tiny removido do sistema."
  };
}

export async function sendPendingProductsToConfiguredTarget(limit?: number): Promise<BatchSendResult> {
  const supabase = supabaseAdmin();
  let query = supabase
    .from("products")
    .select("id")
    .in("status", PENDING_PRODUCT_STATUSES)
    .order("created_at", { ascending: true });
  if (limit && limit > 0) query = query.limit(limit);
  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const products = data ?? [];
  const target = await getProductSendTarget();
  const results: SendResult[] = [];
  await saveBatchSendProgress({
    status: "running",
    totalFiles: products.length,
    processedFiles: 0,
    percent: products.length > 0 ? 0 : 100,
    sent: 0,
    failed: 0,
    message: "Iniciando envio de produtos."
  });

  for (const [index, product] of products.entries()) {
    try {
      results.push(await sendProductToConfiguredTarget(product.id));
    } catch (errorResult) {
      results.push({
        ok: false,
        productId: product.id,
        message: errorResult instanceof Error ? errorResult.message : String(errorResult)
      });
    }

    await saveBatchSendProgress({
      status: "running",
      totalFiles: products.length,
      processedFiles: results.length,
      percent: products.length > 0 ? Math.round((results.length / products.length) * 100) : 100,
      sent: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      message: `Produtos processados ${results.length} de ${products.length}.`
    });

    if (target === "TINY" && index < products.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 7000));
    }
  }

  const result = {
    total: products.length,
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
    finishedAt: new Date().toISOString()
  };

  await supabase.from("settings").upsert({
    key: "PRODUCT_SEND_BATCH_LAST_RESULT",
    value: result,
    description: "[INTEGRACOES] Ultimo envio em lote de produtos"
  });

  await saveBatchSendProgress({
    status: result.failed > 0 ? "failed" : "done",
    totalFiles: result.total,
    processedFiles: result.total,
    percent: 100,
    sent: result.sent,
    failed: result.failed,
    message: "Envio em lote concluido."
  });

  return result;
}

export async function getBatchSendProgress() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "PRODUCT_SEND_BATCH_PROGRESS")
    .maybeSingle();

  return data?.value || {
    status: "idle",
    totalFiles: 0,
    processedFiles: 0,
    percent: 0,
    sent: 0,
    failed: 0,
    message: "Aguardando execucao."
  };
}

async function getProductSendTarget() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "PRODUCT_SEND_TARGET")
    .maybeSingle();

  return String(data?.value || "TINY");
}

async function saveBatchSendProgress(progress: BatchSendProgress) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert({
    key: "PRODUCT_SEND_BATCH_PROGRESS",
    value: {
      ...progress,
      updatedAt: new Date().toISOString()
    },
    description: "[INTEGRACOES] Progresso do envio em lote"
  });
}

async function getProductTinyId(productId: string) {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("products")
    .select("tiny_product_id")
    .eq("id", productId)
    .maybeSingle();

  if (!error && data?.tiny_product_id) {
    return String(data.tiny_product_id);
  }

  const { data: lastResult } = await supabase
    .from("settings")
    .select("value")
    .eq("key", `TINY_LAST_PRODUCT_${productId}`)
    .maybeSingle();

  const value = lastResult?.value;
  if (!value || typeof value !== "object") {
    return "";
  }

  return String((value as Record<string, unknown>).idProduto || "");
}

async function hasActiveMarketplace() {
  const supabase = supabaseAdmin();
  const { count, error } = await supabase
    .from("config_marketplace_accounts")
    .select("*", { count: "exact", head: true })
    .eq("active", true);

  if (!error) {
    return Number(count || 0) > 0;
  }

  return false;
}

async function markProductAsSent(productId: string, target: string, tinyProductId?: string) {
  const supabase = supabaseAdmin();
  const payload: Record<string, unknown> = {
    status: "sent",
    sent_target: target,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (tinyProductId) {
    payload.tiny_product_id = tinyProductId;
  }

  const update = await supabase.from("products").update(payload).eq("id", productId);
  if (!update.error) {
    return;
  }

  if (!/sent|tiny_product_id|sent_target|sent_at|schema cache|Could not find/i.test(update.error.message)) {
    throw update.error;
  }

  await supabase
    .from("products")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", productId)
    .throwOnError();
}

async function clearTinyIntegration(productId: string) {
  const supabase = supabaseAdmin();
  const payload = {
    status: "draft",
    sent_target: null,
    sent_at: null,
    tiny_product_id: null,
    updated_at: new Date().toISOString()
  };

  const update = await supabase.from("products").update(payload).eq("id", productId);
  if (update.error && !/sent_target|tiny_product_id|sent_at|schema cache|Could not find/i.test(update.error.message)) {
    throw update.error;
  }

  if (update.error) {
    await supabase
      .from("products")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", productId)
      .throwOnError();
  }

  await supabase.from("settings").delete().eq("key", `TINY_LAST_PRODUCT_${productId}`);
}
