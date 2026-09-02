import { supabaseAdmin } from "./supabase-admin";
import { getMercadoLivreAccountById, getValidMercadoLivreAccessToken } from "./mercado-livre";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { getValidShopeeAccessToken, ShopeeAccountConfig } from "./shopee";
import { createTinyProduct, deactivateTinyProductById, findTinyProductId, getTinyProductInventory, getTinyProductSnapshot, updateTinyProduct, updateTinyProductPriceById, updateTinyProductStockById } from "./tiny";
import { htmlToPlainText } from "./html-to-plain-text";
import { buildMercadoLivreVariationStockPayload } from "./marketplace-stock-payloads";
import { executeConversationReply, markConversationReplyError } from "./marketplace-conversations";
import { normalizeMercadoLivrePackageAttributes } from "./effective-product";
import { prepareManagedTitleRetry } from "./mercado-livre-managed-title";

export type OutgoingActivityInput = {
  destination: "mercado_livre" | "shopee" | "tiny";
  activityType: "stock_update" | "listing_create" | "listing_update" | "listing_delete" | "answer_send" | "question_answer";
  productId?: string | null; sku: string; productName?: string | null;
  accountId?: string | null; listingId?: string | null;
  previousData?: Record<string, unknown>; requestedData: Record<string, unknown>;
  sourceType?: string | null; sourceId?: string | null;
  stockVersion?: number | null;
};

export async function enqueueOutgoingActivity(input: OutgoingActivityInput) {
  const db = supabaseAdmin();
  const deduplicationKey = stockDeduplicationKey(input);
  if (deduplicationKey) {
    const duplicate = await db.from("outgoing_marketplace_activities").select("id")
      .eq("deduplication_key", deduplicationKey).limit(1).maybeSingle().throwOnError();
    if (duplicate.data) return String(duplicate.data.id);
  }
  if (input.activityType === "listing_create") {
    let pending = db.from("outgoing_marketplace_activities").select("id")
      .eq("destination", input.destination).eq("activity_type", input.activityType)
      .eq("product_id", input.productId || "").in("status", ["queued", "processing", "retry"]);
    pending = input.accountId ? pending.eq("marketplace_account_id", input.accountId) : pending.is("marketplace_account_id", null);
    const existing = await pending.limit(1).maybeSingle().throwOnError();
    if (existing.data) return String(existing.data.id);
  }
  if (input.activityType === "stock_update") {
    let pending = db.from("outgoing_marketplace_activities").select("id")
      .eq("destination", input.destination).eq("activity_type", input.activityType)
      .eq("listing_id", input.listingId || "").in("status", ["queued", "retry"]);
    pending = input.accountId ? pending.eq("marketplace_account_id", input.accountId) : pending.is("marketplace_account_id", null);
    const existing = await pending.limit(1).maybeSingle();
    if (existing.data) {
      await db.from("outgoing_marketplace_activities").update({
        requested_data: input.requestedData, source_type: input.sourceType || null,
        source_id: input.sourceId || null, stock_version: input.stockVersion ?? null,
        deduplication_key: deduplicationKey, updated_at: new Date().toISOString()
      }).eq("id", existing.data.id).throwOnError();
      return String(existing.data.id);
    }
  }
  const result = await db.from("outgoing_marketplace_activities").insert({
    destination: input.destination, activity_type: input.activityType,
    product_id: input.productId || null, sku: input.sku, product_name: input.productName || null,
    marketplace_account_id: input.accountId || null, listing_id: input.listingId || null,
    previous_data: input.previousData || {}, requested_data: input.requestedData,
    source_type: input.sourceType || null, source_id: input.sourceId || null
    , stock_version: input.stockVersion ?? null, deduplication_key: deduplicationKey
  }).select("id").single();
  if (result.error && deduplicationKey && /duplicate|unique/i.test(result.error.message)) {
    const duplicate = await db.from("outgoing_marketplace_activities").select("id")
      .eq("deduplication_key", deduplicationKey).single().throwOnError();
    return String(duplicate.data.id);
  }
  if (result.error) throw result.error;
  await history(String(result.data.id), 0, "queued", "queued", { requested: input.requestedData });
  return String(result.data.id);
}

function stockDeduplicationKey(input: OutgoingActivityInput) {
  if (input.activityType !== "stock_update" || input.stockVersion === null || input.stockVersion === undefined || !input.productId || !input.listingId) return null;
  return [input.productId, input.destination, input.accountId || "no-account", input.listingId, input.stockVersion].join(":");
}

export async function processOutgoingActivities(limit = 10) {
  const db = supabaseAdmin();
  const claim = await db.rpc("claim_outgoing_marketplace_activity_queue", { p_limit: Math.min(50, Math.max(1, limit)) });
  if (claim.error) throw new Error(`Falha ao capturar atividades enviadas: ${claim.error.message}`);
  const results = [];
  for (const activity of claim.data || []) {
    try {
      if (activity.activity_type === "stock_update" && activity.product_id && activity.stock_version !== null) {
        const current = await db.from("estoque").select("stock_version").eq("product_id", activity.product_id).maybeSingle().throwOnError();
        if (Number(current.data?.stock_version || 0) > Number(activity.stock_version)) {
          const confirmed = { skipped: true, reason: "superseded", stockVersion: activity.stock_version, currentVersion: current.data?.stock_version };
          await db.from("outgoing_marketplace_activities").update({ status: "completed", confirmed_data: confirmed,
            processing_error: null, processed_at: new Date().toISOString(), processing_started_at: null, updated_at: new Date().toISOString() })
            .eq("id", activity.id).throwOnError();
          await history(String(activity.id), Number(activity.attempt_count), "version_check", "completed", confirmed);
          results.push({ id: activity.id, ok: true, skipped: true });
          continue;
        }
      }
      const confirmed: Record<string, any> = await executeAndConfirm(activity);
      await db.from("outgoing_marketplace_activities").update({ status: "completed", confirmed_data: confirmed,
        listing_id: confirmed.listingId || activity.listing_id || null,
        processing_error: null, processed_at: new Date().toISOString(), processing_started_at: null, updated_at: new Date().toISOString() })
        .eq("id", activity.id).throwOnError();
      if (activity.activity_type === "listing_create" && activity.product_id) {
        await markProductSentWhenAllMarketplacesAreLinked(String(activity.product_id));
      }
      if (activity.activity_type === "stock_update") {
        const confirmedStock = Number(confirmed.stock || 0);
        const confirmedStatus = String(confirmed.status || (confirmedStock <= 0 ? "paused" : "active"));
        await Promise.all([
          db.from("listings").update({ stock: confirmedStock, status: confirmedStatus === "active" ? "active" : "paused",
            last_sync_at: new Date().toISOString(), error_message: null })
            .eq("marketplace_account_id", activity.marketplace_account_id).eq("external_listing_id", activity.listing_id),
          db.from("product_marketplaces").update({ estoque_marketplace: confirmedStock, status_anuncio: confirmedStatus,
            updated_at: new Date().toISOString() })
            .eq("marketplace_account_id", activity.marketplace_account_id).eq("marketplace_product_id", activity.listing_id)
        ]);
      }
      if (activity.activity_type === "listing_update" && ["mercado_livre", "shopee"].includes(String(activity.destination))) {
        const confirmedPrice = Number(confirmed.price);
        const confirmedStock = Number(confirmed.stock);
        const now = new Date().toISOString();
        await Promise.all([
          db.from("listings").update({
            ...(Number.isFinite(confirmedPrice) ? { price: confirmedPrice } : {}),
            ...(Number.isFinite(confirmedStock) ? { stock: confirmedStock } : {}),
            last_sync_at: now, error_message: null
          }).eq("marketplace_account_id", activity.marketplace_account_id).eq("external_listing_id", activity.listing_id),
          db.from("product_marketplaces").update({
            ...(Number.isFinite(confirmedPrice) ? { valor_marketplace: confirmedPrice } : {}),
            ...(Number.isFinite(confirmedStock) ? { estoque_marketplace: confirmedStock } : {}),
            status_anuncio: String(confirmed.status || ""), updated_at: now
          }).eq("marketplace_account_id", activity.marketplace_account_id).eq("marketplace_product_id", activity.listing_id)
        ]);
      }
      await history(String(activity.id), Number(activity.attempt_count), "confirmation", "completed", confirmed);
      results.push({ id: activity.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (["answer_send", "question_answer"].includes(String(activity.activity_type))) {
        await markConversationReplyError(activity, message);
      }
      try {
        if (await recoverMercadoLivreImmutableCondition(activity, message)) {
          await history(String(activity.id), Number(activity.attempt_count), "immutable_condition_recovery", "completed", {
            reason: "Mercado Livre nao permite reenviar condition neste anuncio.",
            action: "Campo condition removido do payload da segunda tentativa."
          });
        }
        if (await recoverMercadoLivreManagedTitle(activity, message)) {
          await history(String(activity.id), Number(activity.attempt_count), "managed_title_recovery", "completed", {
            reason: "Mercado Livre gerencia o titulo deste anuncio.",
            action: "Familia consultada e title removido do payload da proxima tentativa."
          });
        }
      } catch (recoveryError) {
        await history(String(activity.id), Number(activity.attempt_count), "managed_title_recovery", "error", {
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        });
      }
      await db.rpc("requeue_outgoing_marketplace_activity", { p_id: activity.id, p_error: message }).throwOnError();
      await history(String(activity.id), Number(activity.attempt_count), "confirmation", Number(activity.attempt_count) >= 5 ? "error" : "retry", { error: message });
      results.push({ id: activity.id, ok: false, error: message });
    }
  }
  return { claimed: (claim.data || []).length, completed: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, results };
}

export async function drainOutgoingActivities(maxRounds = 8) {
  const totals = { claimed: 0, completed: 0, failed: 0 };
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await processOutgoingActivities(50);
    totals.claimed += result.claimed; totals.completed += result.completed; totals.failed += result.failed;
    if (result.claimed === 0) break;
  }
  return totals;
}

async function markProductSentWhenAllMarketplacesAreLinked(productId: string) {
  const db = supabaseAdmin();
  const [accounts, marketplaceLinks, listingLinks] = await Promise.all([
    db.from("config_marketplace_accounts").select("id").in("marketplace", ["mercado_livre", "shopee"]).eq("active", true).throwOnError(),
    db.from("product_marketplaces").select("marketplace_account_id").eq("product_id", productId)
      .eq("existe_no_marketplace", true).not("marketplace_product_id", "is", null).throwOnError(),
    db.from("listings").select("marketplace_account_id").eq("product_id", productId)
      .not("external_listing_id", "is", null).throwOnError()
  ]);
  const requiredAccountIds = new Set((accounts.data || []).map(account => String(account.id)));
  if (!requiredAccountIds.size) return;
  const linkedAccountIds = new Set([
    ...(marketplaceLinks.data || []).map(link => String(link.marketplace_account_id)),
    ...(listingLinks.data || []).map(link => String(link.marketplace_account_id))
  ]);
  if ([...requiredAccountIds].some(accountId => !linkedAccountIds.has(accountId))) return;
  const now = new Date().toISOString();
  await db.from("products").update({ status: "sent", sent_target: "MARKETPLACE_DIRETO", sent_at: now, updated_at: now })
    .eq("id", productId).throwOnError();
}

async function executeAndConfirm(activity: Record<string, any>) {
  if (["answer_send", "question_answer"].includes(String(activity.activity_type))) return executeConversationReply(activity);
  if (activity.destination === "tiny" && activity.activity_type === "listing_create") return createAndConfirmTiny(activity);
  if (activity.destination === "mercado_livre" && activity.activity_type === "listing_create") return createAndConfirmMercadoLivre(activity);
  if (activity.destination === "shopee" && activity.activity_type === "listing_create") return createAndConfirmShopee(activity);
  if (activity.activity_type === "listing_delete") return deleteAndConfirm(activity);
  if (activity.activity_type === "listing_update") return updateAndConfirmListing(activity);
  if (activity.activity_type !== "stock_update") throw new Error(`Processador ainda nao configurado para ${activity.activity_type}.`);
  const requestedStock = Math.max(0, Number(activity.requested_data?.stock || 0));
  if (activity.destination === "mercado_livre") return updateAndConfirmMercadoLivre(activity, requestedStock);
  if (activity.destination === "shopee") return updateAndConfirmShopee(activity, requestedStock);
  if (activity.destination === "tiny") return updateAndConfirmTiny(activity, requestedStock);
  throw new Error(`Destino nao suportado: ${activity.destination}.`);
}

async function createAndConfirmTiny(activity: Record<string, any>) {
  if (!activity.product_id) throw new Error("Produto interno ausente para criar no Tiny.");
  const db = supabaseAdmin();
  let result;
  try {
    result = await createTinyProduct(String(activity.product_id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Registro em duplicidade/i.test(message)) throw error;
    const product = await db.from("products").select("sku").eq("id", activity.product_id).single().throwOnError();
    if (/nome do produto/i.test(message)) {
      result = await createTinyProduct(String(activity.product_id), true);
    } else {
      const reconciledId = await findTinyProductId(String(product.data.sku || ""));
      if (!reconciledId) throw new Error(`${message}. O cadastro existente nao foi localizado de forma unica para vinculacao automatica.`);
      result = await updateTinyProduct(String(activity.product_id), reconciledId);
    }
  }
  const listingId = String(result.idProduto || "");
  if (!listingId) throw new Error("Tiny nao retornou o identificador do produto.");
  await Promise.all([
    db.from("products").update({ status: "sent", sent_target: "TINY", sent_at: new Date().toISOString(), tiny_product_id: listingId, updated_at: new Date().toISOString() })
      .eq("id", activity.product_id).throwOnError(),
    db.from("settings").upsert({ key: `TINY_LAST_PRODUCT_${activity.product_id}`, value: result, description: "[TINY] Ultimo retorno de envio do produto" }).throwOnError()
  ]);
  return { listingId, status: "created", tinyResult: result };
}

async function deleteAndConfirm(activity: Record<string, any>) {
  const listingId = String(activity.listing_id || "");
  if (activity.destination === "mercado_livre") {
    const account = await getMercadoLivreAccountById(String(activity.marketplace_account_id));
    const token = await getValidMercadoLivreAccessToken(account);
    const current = await mlApi(`/items/${listingId}`, token, "GET");
    const currentStatus = String(current.status || "").toLowerCase();
    const currentSubStatuses = mercadoLivreSubStatuses(current);
    const isForbiddenReview = currentStatus === "under_review" && currentSubStatuses.includes("forbidden");

    // O Mercado Livre bloqueia alteracoes de status durante a revisao. Para
    // under_review + forbidden, a documentacao orienta pular o fechamento e
    // enviar diretamente o marcador de exclusao permanente.
    if (!isForbiddenReview && !["closed", "inactive"].includes(currentStatus)) {
      await mlApi(`/items/${listingId}`, token, "PUT", { status: "closed" });
    }
    if (!currentSubStatuses.includes("deleted")) {
      await mlApi(`/items/${listingId}`, token, "PUT", { deleted: "true" });
    }
    const confirmed = await mlApi(`/items/${listingId}`, token, "GET");
    const confirmedSubStatuses = mercadoLivreSubStatuses(confirmed);
    if (!confirmedSubStatuses.includes("deleted")) {
      throw new Error(`Mercado Livre nao confirmou a exclusao do anuncio ${listingId}. Status ${confirmed.status || "desconhecido"}; sub_status ${confirmedSubStatuses.join(", ") || "ausente"}.`);
    }
    return { listingId, status: confirmed.status, deleted: true };
  }
  if (activity.destination === "shopee") {
    const { client, token, shopId } = await shopeeContext(activity);
    try { await client.deleteProduct(token, shopId, listingId); } catch (error) {
      if (!/abnormal|not found|does not exist/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    return { listingId, status: "deleted", deleted: true };
  }
  if (activity.destination === "tiny") {
    await deactivateTinyProductById(listingId);
    return { listingId, status: "inactive", deleted: true };
  }
  throw new Error(`Destino nao suportado: ${activity.destination}.`);
}

function mercadoLivreSubStatuses(item: Record<string, any>) {
  return (Array.isArray(item.sub_status) ? item.sub_status : [])
    .map((value: unknown) => String(value).toLowerCase());
}

async function updateAndConfirmListing(activity: Record<string, any>) {
  const listingId = String(activity.listing_id || "");
  if (activity.destination === "tiny") {
    if (!activity.product_id) throw new Error("Produto interno ausente para atualizar no Tiny.");
    let result;
    try {
      result = await updateTinyProduct(String(activity.product_id), listingId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Registro em duplicidade\s*-\s*nome do produto/i.test(message)) throw error;
      const currentTinyProduct = await getTinyProductSnapshot(listingId) as Record<string, any>;
      if (String(currentTinyProduct.id || listingId) !== listingId) throw error;
      result = { idProduto: listingId, status: "OK", statusProcessamento: "fallback", http: 200,
        raw: "", json: {}, erros: "", existingProductFallback: true };
    }
    if (String(result.idProduto || "") !== listingId) throw new Error(`Tiny confirmou o produto ${result.idProduto}, esperado ${listingId}.`);
    const db = supabaseAdmin();
    const [product, inventory] = await Promise.all([
      db.from("products").select("price").eq("id", activity.product_id).single().throwOnError(),
      db.from("estoque").select("estoque_disponivel").eq("product_id", activity.product_id).maybeSingle().throwOnError()
    ]);
    const expectedPrice = Number(product.data.price || 0);
    const expectedStock = Math.max(0, Number(inventory.data?.estoque_disponivel || 0));
    await Promise.all([
      updateTinyProductPriceById(listingId, expectedPrice),
      updateTinyProductStockById(listingId, expectedStock)
    ]);
    const remote = await getTinyProductSnapshot(listingId) as Record<string, any>;
    const confirmedPrice = Number(remote.preco ?? remote.preco_promocional ?? -1);
    const confirmedStock = Number(remote.saldo ?? -1);
    if (Math.abs(confirmedPrice - expectedPrice) >= 0.005) throw new Error(`Tiny confirmou preco ${confirmedPrice}, esperado ${expectedPrice}.`);
    if (confirmedStock !== expectedStock) throw new Error(`Tiny confirmou estoque ${confirmedStock}, esperado ${expectedStock}.`);
    return { listingId, status: "updated", price: confirmedPrice, stock: confirmedStock, tinyResult: result };
  }
  if (activity.destination === "mercado_livre") {
    const account = await getMercadoLivreAccountById(String(activity.marketplace_account_id));
    const token = await getValidMercadoLivreAccessToken(account);
    await executePendingMercadoLivreManagedTitle(activity, token);
    if (activity.requested_data?.payload && Object.keys(activity.requested_data.payload).length > 0) {
      const payload = structuredClone(activity.requested_data.payload);
      if (Array.isArray(payload.attributes) && activity.product_id) {
        const product = await supabaseAdmin().from("products").select("height,width,length,weight_gross")
          .eq("id", activity.product_id).single().throwOnError();
        payload.attributes = normalizeMercadoLivrePackageAttributes(payload.attributes, product.data as any);
        activity.requested_data = { ...activity.requested_data, payload };
        await supabaseAdmin().from("outgoing_marketplace_activities")
          .update({ requested_data: activity.requested_data, updated_at: new Date().toISOString() })
          .eq("id", activity.id).throwOnError();
      }
      await mlApi(`/items/${listingId}`, token, "PUT", payload);
    }
    if (activity.requested_data?.description !== undefined) await mlApi(`/items/${listingId}/description`, token, "PUT", { plain_text: htmlToPlainText(String(activity.requested_data.description || "")) });
    const remote = await mlApi(`/items/${listingId}`, token, "GET");
    await synchronizeMercadoLivreManagedProduct(activity, remote);
    return { listingId, status: remote.status, title: remote.title, price: remote.price };
  }
  if (activity.destination === "shopee") {
    const { client, token, shopId } = await shopeeContext(activity);
    const imageUrls = Array.isArray(activity.requested_data?.imageUrls) ? activity.requested_data.imageUrls : [];
    const imageIds = [];
    for (const url of imageUrls) imageIds.push(await client.uploadImageFromUrl(token, shopId, String(url)));
    const updatePayload = structuredClone(activity.requested_data?.payload || {});
    const requestedPrice = Number(updatePayload.original_price);
    delete updatePayload.original_price;
    delete updatePayload.seller_stock;
    await client.updateProduct(token, shopId, {
      item_id: Number(listingId),
      ...updatePayload,
      ...(imageUrls.length ? { image: { image_id_list: imageIds } } : {})
    });
    if (Number.isFinite(requestedPrice)) await client.updatePrice(token, shopId, listingId, requestedPrice);
    if (activity.requested_data?.stock !== undefined) await client.updateStock(token, shopId, listingId, Number(activity.requested_data.stock));
    const requestedStock = activity.requested_data?.stock === undefined ? undefined : Number(activity.requested_data.stock);
    let item: Record<string, any> = {};
    let confirmedPrice = -1;
    let confirmedStock = -1;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
      const remote = await client.getProductById(token, shopId, listingId);
      item = ((remote.response as any)?.item_list || [])[0] || {};
      confirmedPrice = Number(item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price ?? item.original_price ?? item.price ?? -1);
      confirmedStock = Number(item.stock_info_v2?.seller_stock?.[0]?.stock ?? item.stock_info_v2?.summary_info?.total_available_stock ?? item.stock_info?.[0]?.current_stock ?? item.stock ?? -1);
      const priceMatches = !Number.isFinite(requestedPrice) || Math.abs(confirmedPrice - requestedPrice) < 0.005;
      const stockMatches = requestedStock === undefined || confirmedStock === requestedStock;
      if (priceMatches && stockMatches) break;
    }
    if (Number.isFinite(requestedPrice) && Math.abs(confirmedPrice - requestedPrice) >= 0.005) throw new Error(`Shopee confirmou preco ${confirmedPrice}, esperado ${requestedPrice}.`);
    if (requestedStock !== undefined && confirmedStock !== requestedStock) throw new Error(`Shopee confirmou estoque ${confirmedStock}, esperado ${requestedStock}.`);
    return { listingId, status: item.item_status, title: item.item_name, description: item.description,
      ...(Number.isFinite(requestedPrice) ? { price: confirmedPrice } : {}), ...(requestedStock !== undefined ? { stock: confirmedStock } : {}) };
  }
  throw new Error(`Atualizacao ainda nao suportada para ${activity.destination}.`);
}

async function recoverMercadoLivreImmutableCondition(activity: Record<string, any>, message: string) {
  if (activity.destination !== "mercado_livre" || activity.activity_type !== "listing_update" || Number(activity.attempt_count) !== 1) return false;
  if (!/condition is not modifiable|field_not_updatable[^\n]*condition/i.test(message)) return false;
  const requestedData = structuredClone(activity.requested_data || {});
  if (!requestedData.payload || typeof requestedData.payload !== "object" || !("condition" in requestedData.payload)) return false;
  delete requestedData.payload.condition;
  await supabaseAdmin().from("outgoing_marketplace_activities").update({ requested_data: requestedData, updated_at: new Date().toISOString() })
    .eq("id", activity.id).throwOnError();
  activity.requested_data = requestedData;
  return true;
}

function isMercadoLivreManagedTitleError(activity: Record<string, any>, message: string) {
  return activity.destination === "mercado_livre"
    && activity.activity_type === "listing_update"
    && /cannot modify the title if the item has a family_name|BODY_INVALID_FIELDS/i.test(message)
    && /family_name|cause["'\\:_ ]*374/i.test(message);
}

async function recoverMercadoLivreManagedTitle(activity: Record<string, any>, message: string) {
  if (!isMercadoLivreManagedTitleError(activity, message)) return false;
  if (activity.requested_data?.managedTitleRecovery) return false;
  const account = await getMercadoLivreAccountById(String(activity.marketplace_account_id));
  const token = await getValidMercadoLivreAccessToken(account);
  const listingId = String(activity.listing_id || "");
  const remote = await mlApi(`/items/${listingId}`, token, "GET");
  let familyId = String(remote.family_id || "");
  if (!familyId && remote.user_product_id) {
    const userProduct = await mlApi(`/user-products/${remote.user_product_id}`, token, "GET");
    familyId = String(userProduct.family_id || "");
  }
  if (!remote.family_name && !familyId) return false;

  const db = supabaseAdmin();
  const requestedData = prepareManagedTitleRetry(activity.requested_data || {}, {
    familyId,
    familyName: remote.family_name,
    userProductId: remote.user_product_id
  });
  if (!requestedData) return false;
  const now = new Date().toISOString();
  await Promise.all([
    db.from("outgoing_marketplace_activities").update({ requested_data: requestedData, updated_at: now }).eq("id", activity.id).throwOnError(),
    db.from("product_marketplaces").update({
      family_id: familyId || null,
      family_name: String(remote.family_name || "") || null,
      user_product_id: String(remote.user_product_id || "") || null,
      titulo_marketplace: String(remote.title || "") || null,
      raw_data: remote,
      updated_at: now
    }).eq("marketplace_account_id", activity.marketplace_account_id).eq("marketplace_product_id", listingId).throwOnError()
  ]);
  activity.requested_data = requestedData;
  return true;
}

async function executePendingMercadoLivreManagedTitle(activity: Record<string, any>, token: string) {
  const recovery = activity.requested_data?.managedTitleRecovery;
  if (!recovery || recovery.status !== "pending") return;
  const requestedTitle = String(recovery.requestedTitle || "").trim();
  if (!requestedTitle) throw new Error("Titulo solicitado ausente em managedTitleRecovery.requestedTitle.");
  const listingId = String(activity.listing_id || "");
  if (!listingId) throw new Error("Anuncio ausente para atualizar family_name no Mercado Livre.");

  let remote = await mlApi(`/items/${listingId}`, token, "GET");
  let userProduct: Record<string, any> = {};
  const userProductId = String(remote.user_product_id || recovery.userProductId || "");
  if (userProductId && (!remote.family_id || !remote.family_name)) {
    userProduct = await mlApi(`/user-products/${userProductId}`, token, "GET");
  }
  const currentFamilyName = String(remote.family_name || userProduct.family_name || "").trim();
  if (currentFamilyName !== requestedTitle) {
    await history(String(activity.id), Number(activity.attempt_count), "managed_title_update", "processing", {
      listingId, requestedTitle, action: "PUT /items/{item_id}/family_name"
    });
    try {
      await mlApi(`/items/${listingId}/family_name`, token, "PUT", { family_name: requestedTitle });
    } catch (error) {
      await history(String(activity.id), Number(activity.attempt_count), "managed_title_update", "error", {
        listingId, requestedTitle, error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      throw error;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
      remote = await mlApi(`/items/${listingId}`, token, "GET");
      if (String(remote.family_name || "").trim() === requestedTitle) break;
    }
    if (String(remote.family_name || "").trim() !== requestedTitle) {
      throw new Error(`Mercado Livre nao confirmou family_name "${requestedTitle}" para o anuncio ${listingId}.`);
    }
  } else {
    await history(String(activity.id), Number(activity.attempt_count), "managed_title_update", "completed", {
      listingId, requestedTitle, action: "already_confirmed"
    });
  }

  const completedRecovery = {
    ...recovery,
    status: "completed",
    familyId: String(remote.family_id || userProduct.family_id || recovery.familyId || "") || null,
    familyName: String(remote.family_name || requestedTitle),
    userProductId: String(remote.user_product_id || userProduct.id || recovery.userProductId || "") || null,
    confirmedTitle: String(remote.title || "") || null
  };
  activity.requested_data = { ...activity.requested_data, managedTitleRecovery: completedRecovery };
  await supabaseAdmin().from("outgoing_marketplace_activities")
    .update({ requested_data: activity.requested_data, updated_at: new Date().toISOString() })
    .eq("id", activity.id).throwOnError();
  if (currentFamilyName !== requestedTitle) {
    await history(String(activity.id), Number(activity.attempt_count), "managed_title_update", "completed", {
      listingId, requestedTitle, confirmedTitle: completedRecovery.confirmedTitle
    });
  }
  await synchronizeMercadoLivreManagedProduct(activity, remote);
}

async function synchronizeMercadoLivreManagedProduct(activity: Record<string, any>, remote: Record<string, any>) {
  if (!activity.product_id || (!remote.family_name && !remote.family_id)) return;
  const db = supabaseAdmin();
  const title = String(remote.title || "").trim();
  const now = new Date().toISOString();
  await Promise.all([
    title ? db.from("products").update({ title, updated_at: now }).eq("id", activity.product_id).throwOnError() : Promise.resolve(),
    db.from("product_marketplaces").update({
      family_id: String(remote.family_id || "") || null,
      family_name: String(remote.family_name || "") || null,
      user_product_id: String(remote.user_product_id || "") || null,
      titulo_marketplace: title || null,
      valor_marketplace: Number(remote.price || 0),
      status_anuncio: String(remote.status || ""),
      raw_data: remote,
      updated_at: now
    }).eq("marketplace_account_id", activity.marketplace_account_id).eq("marketplace_product_id", activity.listing_id).throwOnError()
  ]);
}

async function shopeeContext(activity: Record<string, any>) {
  const result = await supabaseAdmin().from("config_marketplace_accounts")
    .select("id,name,marketplace,active,shop_id,account_id,access_token,refresh_token,token_expires_at,status")
    .eq("id", activity.marketplace_account_id).single().throwOnError();
  const account = result.data as ShopeeAccountConfig;
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error(`Shop ID ausente para ${account.name}.`);
  const token = await getValidShopeeAccessToken(account);
  return { client: createShopeeClient(await getShopeeOAuthConfig(account.id)), token, shopId };
}

async function createAndConfirmShopee(activity: Record<string, any>) {
  const result = await supabaseAdmin().from("config_marketplace_accounts")
    .select("id,name,marketplace,active,shop_id,account_id,access_token,refresh_token,token_expires_at,status")
    .eq("id", activity.marketplace_account_id).single().throwOnError();
  const account = result.data as ShopeeAccountConfig;
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error(`Shop ID ausente para ${account.name}.`);
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  let listingId = String(activity.listing_id || "");
  if (!listingId) {
    const imageIds = [];
    for (const url of activity.requested_data?.imageUrls || []) imageIds.push(await client.uploadImageFromUrl(token, shopId, String(url)));
    const logistics = await client.getLogisticsChannels(token, shopId);
    const logisticInfo = (logistics.response?.logistics_channel_list || []).filter((entry: any) => entry.enabled)
      .map((entry: any) => ({ logistic_id: Number(entry.logistics_channel_id), enabled: true }));
    const created = await client.createProduct(token, shopId, {
      ...(activity.requested_data?.payload || {}), image: { image_id_list: imageIds }, logistic_info: logisticInfo
    });
    listingId = String((created as any).response?.item_id || "");
    if (!listingId) throw new Error(`Shopee nao retornou o ID do anuncio: ${JSON.stringify(created)}`);
    await supabaseAdmin().from("outgoing_marketplace_activities").update({ listing_id: listingId, updated_at: new Date().toISOString() })
      .eq("id", activity.id).throwOnError();
  }
  const snapshot = await client.getProductById(token, shopId, listingId);
  const remote = ((snapshot.response as any)?.item_list || [])[0] || {};
  if (String(remote.item_id || "") !== listingId) throw new Error(`Anuncio ${listingId} nao confirmado na Shopee.`);
  const stock = Number(remote.stock_info_v2?.seller_stock?.[0]?.stock ?? remote.stock_info_v2?.summary_info?.total_available_stock ?? remote.stock_info?.[0]?.current_stock ?? remote.stock ?? 0);
  const db = supabaseAdmin();
  const marketplacePayload = { product_id: activity.product_id, sku: activity.sku, marketplace: "shopee",
    marketplace_account_id: activity.marketplace_account_id, marketplace_product_id: listingId, titulo_marketplace: activity.product_name,
    valor_marketplace: Number(remote.price_info?.[0]?.original_price || activity.requested_data?.payload?.original_price || 0), estoque_marketplace: stock,
    status_anuncio: remote.item_status || "NORMAL", existe_no_marketplace: true, raw_data: remote, updated_at: new Date().toISOString() };
  const listingPayload = { product_id: activity.product_id, marketplace: "shopee", marketplace_account_id: activity.marketplace_account_id,
    marketplace_name: activity.requested_data?.accountName || "Shopee", external_listing_id: listingId, external_sku: activity.sku,
    status: "active", stock, price: Number(activity.requested_data?.payload?.original_price || 0), last_sync_at: new Date().toISOString(), error_message: null };
  const [marketplaceExisting, listingExisting] = await Promise.all([
    db.from("product_marketplaces").select("id").eq("marketplace_account_id", activity.marketplace_account_id).eq("marketplace_product_id", listingId).maybeSingle(),
    db.from("listings").select("id").eq("product_id", activity.product_id).eq("marketplace_account_id", activity.marketplace_account_id).maybeSingle()
  ]);
  await Promise.all([
    marketplaceExisting.data ? db.from("product_marketplaces").update(marketplacePayload).eq("id", marketplaceExisting.data.id).throwOnError() : db.from("product_marketplaces").insert(marketplacePayload).throwOnError(),
    listingExisting.data ? db.from("listings").update(listingPayload).eq("id", listingExisting.data.id).throwOnError() : db.from("listings").insert(listingPayload).throwOnError()
  ]);
  return { listingId, status: remote.item_status || "NORMAL", stock, gtinCode: remote.gtin_code || "00",
    warrantyMonths: activity.requested_data?.warrantyMonths || 0 };
}

async function createAndConfirmMercadoLivre(activity: Record<string, any>) {
  const account = await getMercadoLivreAccountById(String(activity.marketplace_account_id));
  const token = await getValidMercadoLivreAccessToken(account);
  let listingId = String(activity.listing_id || "");
  if (!listingId) {
    const payload = structuredClone(activity.requested_data?.payload || {});
    if (activity.product_id) {
      const product = await supabaseAdmin().from("products").select("model,board_code").eq("id", activity.product_id).maybeSingle().throwOnError();
      const attributes = Array.isArray(payload.attributes) ? payload.attributes : [];
      upsertMercadoLivreTextAttribute(attributes, "MODEL", product.data?.model);
      upsertMercadoLivreTextAttribute(attributes, "BOARD_CODE", product.data?.board_code);
      payload.attributes = attributes;
    }
    const created = await mlApi("/items", token, "POST", payload);
    listingId = String(created.id || "");
    if (!listingId) throw new Error("Mercado Livre nao retornou o ID do anuncio.");
    await supabaseAdmin().from("outgoing_marketplace_activities")
      .update({ listing_id: listingId, updated_at: new Date().toISOString() })
      .eq("id", activity.id).throwOnError();
  }
  const description = htmlToPlainText(String(activity.requested_data?.description || ""));
  if (description) await mlApi(`/items/${listingId}/description`, token, "POST", { plain_text: description });
  const remote = await mlApi(`/items/${listingId}`, token, "GET");
  if (!remote.id || !["active", "paused"].includes(String(remote.status))) throw new Error(`Anuncio ${listingId} nao confirmado no Mercado Livre.`);
  const db = supabaseAdmin();
  const marketplacePayload = { product_id: activity.product_id, sku: activity.sku, marketplace: "mercado_livre",
      marketplace_account_id: activity.marketplace_account_id, marketplace_product_id: listingId, titulo_marketplace: activity.product_name,
      valor_marketplace: Number(remote.price || 0), estoque_marketplace: Number(remote.available_quantity || 0), status_anuncio: remote.status,
      existe_no_marketplace: true, raw_data: remote, updated_at: new Date().toISOString() };
  const listingPayload = { product_id: activity.product_id, marketplace: "mercado_livre", marketplace_account_id: activity.marketplace_account_id,
      marketplace_name: activity.requested_data?.accountName || "Mercado Livre", external_listing_id: listingId, external_sku: activity.sku,
      status: remote.status, stock: Number(remote.available_quantity || 0), price: Number(remote.price || 0), last_sync_at: new Date().toISOString(), error_message: null };
  const [marketplaceExisting, listingExisting] = await Promise.all([
    db.from("product_marketplaces").select("id").eq("marketplace_account_id", activity.marketplace_account_id).eq("marketplace_product_id", listingId).maybeSingle(),
    db.from("listings").select("id").eq("product_id", activity.product_id).eq("marketplace_account_id", activity.marketplace_account_id).maybeSingle()
  ]);
  await Promise.all([
    marketplaceExisting.data
      ? db.from("product_marketplaces").update(marketplacePayload).eq("id", marketplaceExisting.data.id).throwOnError()
      : db.from("product_marketplaces").insert(marketplacePayload).throwOnError(),
    listingExisting.data
      ? db.from("listings").update(listingPayload).eq("id", listingExisting.data.id).throwOnError()
      : db.from("listings").insert(listingPayload).throwOnError()
  ]);
  return { listingId, status: remote.status, stock: Number(remote.available_quantity || 0), condition: remote.condition,
    listingType: remote.listing_type_id, warranty: remote.warranty };
}

function upsertMercadoLivreTextAttribute(attributes: Array<Record<string, any>>, id: string, rawValue: unknown) {
  const value = String(rawValue || "").trim();
  if (!value) return;
  const existing = attributes.find(attribute => String(attribute.id) === id);
  if (existing) {
    if (!existing.value_id && !String(existing.value_name || "").trim() && !existing.values?.length) existing.value_name = value;
    return;
  }
  attributes.push({ id, value_name: value });
}

async function updateAndConfirmTiny(activity: Record<string, any>, stock: number) {
  const tinyProductId = String(activity.listing_id || "");
  if (!tinyProductId) throw new Error("Identificador do produto Tiny ausente.");
  await updateTinyProductStockById(tinyProductId, stock);
  const snapshot = await getTinyProductInventory(tinyProductId) as Record<string, any>;
  const deposits = snapshot?.depositos || snapshot?.retorno?.produto?.depositos || snapshot?.produto?.depositos || [];
  const confirmed = Math.max(0, Math.trunc((deposits as Array<Record<string, any>>).reduce((sum, item) => sum + Number(item.deposito?.saldo || 0), 0)));
  if (confirmed !== stock) throw new Error(`Tiny confirmou estoque ${confirmed}, esperado ${stock}.`);
  return { stock: confirmed, status: confirmed > 0 ? "active" : "zero" };
}

async function updateAndConfirmMercadoLivre(activity: Record<string, any>, stock: number) {
  const account = await getMercadoLivreAccountById(String(activity.marketplace_account_id));
  const token = await getValidMercadoLivreAccessToken(account);
  const listingId = String(activity.listing_id);
  const variationIds = [...new Set([
    ...(Array.isArray(activity.requested_data?.variationIds) ? activity.requested_data.variationIds : []),
    activity.requested_data?.variationId
  ].map(Number).filter((id) => id > 0))];
  if (variationIds.length > 0) {
    await mlRequest(listingId, token, "PUT", buildMercadoLivreVariationStockPayload(variationIds, stock));
    const remote = await mlRequest(listingId, token, "GET");
    const remoteVariations = Array.isArray(remote.variations) ? remote.variations : [];
    for (const variationId of variationIds) {
      const variation = remoteVariations.find((entry: Record<string, any>) => Number(entry.id) === variationId);
      if (!variation) throw new Error(`Mercado Livre nao retornou a variacao ${variationId} do anuncio ${listingId}.`);
      if (Number(variation.available_quantity) !== stock) {
        throw new Error(`Mercado Livre confirmou estoque ${variation.available_quantity} na variacao ${variationId}, esperado ${stock}.`);
      }
    }
    return { stock, status: remote.status, listingId, variationIds };
  }
  const body = stock <= 0 ? { status: "paused" } : { status: "active", available_quantity: stock };
  await mlRequest(listingId, token, "PUT", body);
  const remote = await mlRequest(listingId, token, "GET");
  if (stock <= 0 && !["paused", "closed", "inactive"].includes(String(remote.status))) throw new Error(`Mercado Livre confirmou status ${remote.status}, esperado indisponivel.`);
  if (stock > 0 && Number(remote.available_quantity) !== stock) throw new Error(`Mercado Livre confirmou estoque ${remote.available_quantity}, esperado ${stock}.`);
  // O Mercado Livre preserva available_quantity ao pausar um anuncio. Para o
  // sistema, a confirmacao de indisponibilidade representa saldo publicavel 0.
  return { stock: stock <= 0 ? 0 : Number(remote.available_quantity || 0), status: remote.status };
}

async function updateAndConfirmShopee(activity: Record<string, any>, stock: number) {
  const result = await supabaseAdmin().from("config_marketplace_accounts")
    .select("id,name,marketplace,active,shop_id,account_id,access_token,refresh_token,token_expires_at,status")
    .eq("id", activity.marketplace_account_id).single().throwOnError();
  const account = result.data as ShopeeAccountConfig;
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error(`Shop ID ausente para ${account.name}.`);
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const requestedModelIds: unknown[] = Array.isArray(activity.requested_data?.modelIds) ? activity.requested_data.modelIds : [];
  const modelIds: number[] = [...new Set(requestedModelIds.map(Number).filter((id: number) => id > 0))];
  await client.updateStock(token, shopId, activity.listing_id, stock, modelIds);
  if (modelIds.length) {
    const remote = await client.getModelList(token, shopId, activity.listing_id) as Record<string, any>;
    const models = remote.response?.model || remote.response?.model_list || [];
    for (const modelId of modelIds) {
      const model = models.find((entry: Record<string, any>) => Number(entry.model_id) === modelId);
      const confirmed = Number(model?.stock_info_v2?.seller_stock?.[0]?.stock
        ?? model?.stock_info?.[0]?.current_stock ?? model?.stock ?? -1);
      if (confirmed !== stock) throw new Error(`Shopee confirmou estoque ${confirmed} no modelo ${modelId}, esperado ${stock}.`);
    }
    return { stock, status: "linked", listingId: String(activity.listing_id), modelIds };
  }
  let item: Record<string, any> = {};
  let confirmed = -1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1000));
    const remote = await client.getProductById(token, shopId, activity.listing_id);
    item = ((remote.response as any)?.item_list || [])[0] || {};
    confirmed = Number(item.stock_info_v2?.seller_stock?.[0]?.stock ?? item.stock_info_v2?.summary_info?.total_available_stock ?? item.stock_info?.[0]?.current_stock ?? item.stock ?? -1);
    if (confirmed === stock) break;
  }
  if (confirmed !== stock) throw new Error(`Shopee confirmou estoque ${confirmed}, esperado ${stock}.`);
  return { stock: confirmed, status: item.item_status || item.status };
}

async function mlRequest(listingId: string, token: string, method: "GET" | "PUT", body?: Record<string, unknown>) {
  return mlApi(`/items/${listingId}`, token, method, body);
}

async function mlApi(path: string, token: string, method: "GET" | "POST" | "PUT", body?: Record<string, unknown>) {
  const response = await fetch(`https://api.mercadolibre.com${path}`, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mercado Livre (${response.status}): ${JSON.stringify(json)}`);
  return json as Record<string, any>;
}

async function history(activityId: string, attempt: number, stage: string, status: string, details: Record<string, unknown>) {
  await supabaseAdmin().from("outgoing_marketplace_activity_history").insert({ activity_id: activityId, attempt, stage, status, details });
}
