import { createTinyProduct, deactivateTinyProductById, findTinyProductId, updateTinyProduct } from "./tiny";
import { supabaseAdmin } from "./supabase-admin";
import { removeMercadoLivreListing } from "./mercado-livre";

type SendResult = {
  ok: boolean;
  productId: string;
  message: string;
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

const PENDING_STATUSES = ["draft", "ready", "publishing"];

export async function sendProductToConfiguredTarget(productId: string): Promise<SendResult> {
  const supabase = supabaseAdmin();
  const existingTinyId = await getProductTinyId(productId);
  if (existingTinyId) {
    const tinyResult = await updateTinyProduct(productId, existingTinyId);
    await markProductAsSent(productId, "TINY", tinyResult.idProduto);
    await supabase.from("settings").upsert({
      key: `TINY_LAST_PRODUCT_${productId}`,
      value: tinyResult,
      description: "[TINY] Ultimo retorno de envio do produto"
    });

    return { ok: true, productId, message: `Produto atualizado no Tiny. ID: ${tinyResult.idProduto}` };
  }

  const target = await getProductSendTarget();

  if (target === "MARKETPLACE_DIRETO") {
    const hasMarketplace = await hasActiveMarketplace();
    if (!hasMarketplace) {
      return { ok: false, productId, message: "Nenhum MarketPlace configurado." };
    }

    return {
      ok: false,
      productId,
      message: "Envio direto nao confirmado: nenhuma API de publicacao foi executada. O produto permaneceu pendente. Selecione Tiny ou configure a publicacao direta por conta."
    };
  }

  let tinyResult;
  try {
    tinyResult = await createTinyProduct(productId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Registro em duplicidade/i.test(message)) throw error;
    const { data: product } = await supabase.from("products").select("sku,title").eq("id", productId).single().throwOnError();
    if (/nome do produto/i.test(message)) {
      tinyResult = await createTinyProduct(productId, true);
    } else {
      const reconciledId = await findTinyProductId(String(product.sku || ""));
      if (!reconciledId) {
        throw new Error(`${message}. O cadastro existente nao foi localizado de forma unica para vinculacao automatica.`);
      }
      tinyResult = await updateTinyProduct(productId, reconciledId);
    }
  }

  await markProductAsSent(productId, "TINY", tinyResult.idProduto);
  await supabase.from("settings").upsert({
    key: `TINY_LAST_PRODUCT_${productId}`,
    value: tinyResult,
    description: "[TINY] Ultimo retorno de envio do produto"
  });

  return {
    ok: true,
    productId,
    message: `Produto enviado ao Tiny. ID: ${tinyResult.idProduto}`
  };
}

export async function removeProductIntegration(productId: string, integration: string, deleteExternal: boolean, externalId = "", accountId = ""): Promise<SendResult> {
  if (integration === "MERCADO_LIVRE") {
    if (!externalId || !accountId) return { ok: false, productId, message: "Anuncio ou conta do Mercado Livre nao informados." };
    if (deleteExternal) await removeMercadoLivreListing(accountId, externalId);
    await supabaseAdmin().from("product_marketplaces").update({ existe_no_marketplace: false, status_anuncio: deleteExternal ? "deleted" : "unlinked", updated_at: new Date().toISOString() }).eq("product_id", productId).eq("marketplace_account_id", accountId).eq("marketplace_product_id", externalId).throwOnError();
    return { ok: true, productId, message: deleteExternal ? "Anuncio excluido no Mercado Livre e vinculo removido." : "Vinculo do Mercado Livre removido apenas do sistema." };
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
    const tinyResult = await deactivateTinyProductById(tinyProductId);
    await supabaseAdmin().from("settings").upsert({
      key: `TINY_LAST_DEACTIVATE_PRODUCT_${productId}`,
      value: tinyResult,
      description: "[TINY] Ultimo retorno de inativacao do produto"
    });
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

export async function sendPendingProductsToConfiguredTarget(): Promise<BatchSendResult> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("products")
    .select("id")
    .in("status", PENDING_STATUSES)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const products = data ?? [];
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

  for (const product of products) {
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
