import { evaluatePriceForProduct, type PriceEvaluationProduct } from "./price-evaluation";
import { supabaseAdmin } from "./supabase-admin";

export type PriceBatchResult = {
  total: number;
  processed: number;
  failed: number;
  results: Array<{ productId: string; sku: string; ok: boolean; price?: number; status?: string; message: string }>;
  finishedAt: string;
};

export async function processPendingProductPrices(limit = 5): Promise<PriceBatchResult> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("products")
    .select("id,sku,source_key,title,type_code,brand_code,model,version,board_code")
    .eq("status", "pending_price")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 20));
  if (error) throw new Error(error.message);

  const results: PriceBatchResult["results"] = [];
  for (const row of data || []) {
    try {
      const evaluation = await evaluatePriceForProduct(row as PriceEvaluationProduct);
      if (!evaluation.listings.length) {
        throw new Error(evaluation.error || "Busca automatizada sem resultados; produto mantido pendente de preço.");
      }
      if (evaluation.status === "VERIFICACAO_MANUAL") {
        const evaluatedAt = new Date().toISOString();
        await db.from("products").update({
          status: "manual_price",
          price_evaluation_status: "DEFINIR_PRECO_MANUAL",
          price_evaluation_result: compactEvaluation(evaluation),
          price_evaluated_at: evaluatedAt,
          price_evaluation_error: null,
          updated_at: evaluatedAt
        }).eq("id", row.id).throwOnError();
        results.push({ productId: row.id, sku: row.sku, ok: true, status: "DEFINIR_PRECO_MANUAL", message: "Amostra insuficiente; produto aguardando definição manual de preço." });
        continue;
      }
      const price = Number(evaluation.suggested);
      if (!Number.isFinite(price) || price <= 0) throw new Error("Motor de preço não retornou um valor válido.");
      await db.from("products").update({
        price,
        status: "draft",
        price_evaluation_status: evaluation.status,
        price_evaluation_result: compactEvaluation(evaluation),
        price_evaluated_at: new Date().toISOString(),
        price_evaluation_error: evaluation.error || null,
        updated_at: new Date().toISOString()
      }).eq("id", row.id).throwOnError();
      await db.from("listings").update({ price }).eq("product_id", row.id).throwOnError();
      results.push({ productId: row.id, sku: row.sku, ok: true, price, status: evaluation.status, message: "Preço processado; produto pendente de envio." });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await db.from("products").update({
        price_evaluation_status: "ERRO",
        price_evaluation_error: message,
        price_evaluated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", row.id);
      results.push({ productId: row.id, sku: row.sku, ok: false, message });
    }
  }

  const result = {
    total: results.length,
    processed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
    finishedAt: new Date().toISOString()
  };
  await db.from("settings").upsert({ key: "PRICE_BATCH_LAST_RESULT", value: result, description: "[PRECO] Resultado do último processamento batch de preços" });
  return result;
}

function compactEvaluation(evaluation: Awaited<ReturnType<typeof evaluatePriceForProduct>>) {
  return {
    status: evaluation.status,
    searchString: evaluation.searchString,
    searchUrl: evaluation.searchUrl,
    catalogUrl: evaluation.catalogUrl,
    searchSource: evaluation.searchSource,
    searchedAt: evaluation.searchedAt,
    cacheExpiresAt: evaluation.cacheExpiresAt,
    recovered: evaluation.listings.length,
    valid: evaluation.listings.filter((item) => item.valid).length,
    considered: evaluation.listings.filter((item) => item.considered).length,
    lowest: evaluation.lowest,
    secondLowest: evaluation.secondLowest,
    average: evaluation.average,
    highest: evaluation.highest,
    suggested: evaluation.suggested,
    basedOnMinimum: evaluation.basedOnMinimum,
    appliedRange: evaluation.appliedRange,
    error: evaluation.error || null
  };
}
