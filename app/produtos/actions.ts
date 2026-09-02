"use server";

import { deleteProductById, inspectProductDeletion } from "@/lib/products";
import { removeProductIntegration, sendProductToConfiguredTarget } from "@/lib/product-sender";
import { enqueueDirectListingUpdates } from "@/lib/direct-marketplace-publisher";
import { drainOutgoingActivities, enqueueOutgoingActivity } from "@/lib/outgoing-activities";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { syncListingsStock } from "@/lib/inventory";
import { deleteCloudinaryResource, uploadProductImageToCloudinary } from "@/lib/cloudinary";
import { synchronizeProductById } from "@/lib/product-point-sync";
import { cloneProduct } from "@/lib/product-cloner";
import { waitUntil } from "@vercel/functions";
import { fetchMarketplaceCategoryDefinition, validateRequiredAttributes, type MarketplaceDefinitions, type MarketplaceValues } from "@/lib/marketplace-attributes";
import { getMarketplaceCategoryPath } from "@/lib/marketplace-categories";
import { validateMarketplaceImage } from "@/lib/marketplace-image-validation";
import { resolveMarketplaceRecoveryImageUrls } from "@/lib/marketplace-temporary-images";

export async function cloneProductAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const returnTo = String(formData.get("returnTo") || "/produtos");
  if (!productId) redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado para clonagem.")}`);
  let clone: Awaited<ReturnType<typeof cloneProduct>>;
  try {
    clone = await cloneProduct(productId);
    revalidatePath("/");
    revalidatePath("/produtos");
  } catch (error) {
    const target = safeProductsReturn(returnTo);
    redirect(`${target}?erro=${encodeURIComponent(`Nao foi possivel clonar o produto: ${error instanceof Error ? error.message : String(error)}`)}`);
  }
  const message = `Produto Clonado com sucesso: SKU ${clone.sku} - ${clone.title}`;
  const target = returnTo.startsWith("/produtos/") ? `/produtos/${clone.id}` : safeProductsReturn(returnTo);
  redirect(`${target}?sucesso=${encodeURIComponent(message)}`);
}

export async function deleteProductAction(formData: FormData) {
  await deleteProductById(formData);
}

export async function inspectProductDeletionAction(productId: string, manualTinyConfirmation = false) {
  return inspectProductDeletion(productId, manualTinyConfirmation);
}

export async function sendProductAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const returnTo = safeProductsReturn(String(formData.get("returnTo") || "/produtos"));
  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof sendProductToConfiguredTarget>>;
  try {
    result = await sendProductToConfiguredTarget(productId);
  } catch (error) {
    redirect(withMessage(returnTo, "erro", error instanceof Error ? error.message : String(error)));
  }

  revalidatePath("/");
  revalidatePath("/produtos");
  waitUntil(drainOutgoingActivities());

  const param = result.ok ? "sucesso" : "erro";
  redirect(withMessage(returnTo, param, result.message));
}

export async function sendProductDetailAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof sendProductToConfiguredTarget>>;
  try {
    result = await sendProductToConfiguredTarget(productId);
  } catch (error) {
    redirect(`/produtos/${productId}?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${productId}`);
  waitUntil(drainOutgoingActivities());

  const param = result.ok ? "sucesso" : "erro";
  redirect(`/produtos/${productId}?${param}=${encodeURIComponent(result.message)}`);
}

export async function resendProductIntegrationAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const integration = String(formData.get("integration") || "").toUpperCase();
  const externalId = String(formData.get("externalId") || "");
  const accountId = String(formData.get("accountId") || "");
  if (!productId || !externalId) redirect(`/produtos/${productId}?erro=${encodeURIComponent("Integracao nao identificada.")}`);
  try {
    const imageRows = await supabaseAdmin().from("product_images").select("bytes,width_px,height_px").eq("product_id", productId).throwOnError();
    if (!imageRows.data.length || imageRows.data.some(image => validateMarketplaceImage({ width: Number(image.width_px), height: Number(image.height_px), bytes: Number(image.bytes) }).length > 0)) {
      throw new Error("Corrija todas as fotos fora do padrão antes de reenviar o produto.");
    }
    if (integration === "TINY") {
      const product = await supabaseAdmin().from("products").select("sku,title").eq("id", productId).single().throwOnError();
      const activityId = await enqueueOutgoingActivity({ destination: "tiny", activityType: "listing_update", productId,
        sku: product.data.sku, productName: product.data.title, listingId: externalId, previousData: {},
        requestedData: { useCurrentProductData: true }, sourceType: "product_detail_resend", sourceId: productId });
      await drainOutgoingActivities();
      const activity = await supabaseAdmin().from("outgoing_marketplace_activities").select("status,processing_error").eq("id", activityId).single().throwOnError();
      if (activity.data.status !== "completed") throw new Error(activity.data.processing_error || "Atualizacao Tiny nao confirmada.");
    } else {
      const marketplace = integration === "SHOPEE" ? "shopee" : "mercado_livre";
      const ids = await enqueueDirectListingUpdates(productId, { marketplace, accountId, listingId: externalId });
      if (!ids.length) throw new Error("Vinculo do anuncio nao encontrado para atualizacao.");
      const failed = await supabaseAdmin().from("outgoing_marketplace_activities").select("processing_error")
        .in("id", ids).neq("status", "completed").limit(1).maybeSingle().throwOnError();
      if (failed.data) throw new Error(failed.data.processing_error || "Atualizacao externa nao confirmada.");
    }
  } catch (error) {
    redirect(`/produtos/${productId}?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
  revalidatePath(`/produtos/${productId}`); revalidatePath("/atividades-marketplace/enviadas");
  redirect(`/produtos/${productId}?sucesso=${encodeURIComponent("Atualizacao enfileirada e confirmada na integracao selecionada.")}`);
}

export async function synchronizeProductAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const returnTo = safeProductsReturn(String(formData.get("returnTo") || "/produtos"));
  if (!productId) redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  let result: Awaited<ReturnType<typeof synchronizeProductById>>;
  try {
    result = await synchronizeProductById(productId);
  } catch (error) {
    redirect(withMessage(returnTo, "erro", `Falha no sincronismo: ${error instanceof Error ? error.message : String(error)}`));
  }
  revalidatePath("/");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${productId}`);
  revalidatePath("/logs");
  const message = result.errors.length
    ? `Sincronismo do SKU ${result.sku} concluido com ${result.errors.length} alerta(s). Consulte o Log.`
    : `SKU ${result.sku} sincronizado. ${result.listings.length} anuncio(s) encontrado(s). Consulte o Log.`;
  redirect(withMessage(returnTo, "sucesso", message));
}

export async function removeProductIntegrationAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const integration = String(formData.get("integration") || "");
  const deleteExternal = String(formData.get("deleteExternal") || "") === "true";
  const externalId = String(formData.get("externalId") || "");
  const accountId = String(formData.get("accountId") || "");

  if (!productId) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao informado.")}`);
  }

  let result: Awaited<ReturnType<typeof removeProductIntegration>>;
  try {
    result = await removeProductIntegration(productId, integration, deleteExternal, externalId, accountId);
  } catch (error) {
    redirect(`/produtos/${productId}?erro=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }

  revalidatePath("/");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${productId}`);

  const param = result.ok ? "sucesso" : "erro";
  redirect(`/produtos/${productId}?${param}=${encodeURIComponent(result.message)}`);
}

export async function updateProductInlineAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const returnTo = safeProductsReturn(String(formData.get("returnTo") || "/produtos"));
  const sendAfterSave = String(formData.get("intent") || "") === "send";
  const title = String(formData.get("title") || "").trim();
  const price = Number(String(formData.get("price") || "0").replace(",", "."));
  const stock = Math.max(0, Math.trunc(Number(formData.get("stock") || 0)));
  if (!productId || !title || !Number.isFinite(price) || price < 0) redirect(`/produtos?erro=${encodeURIComponent("Dados do produto invalidos.")}`);
  const db = supabaseAdmin();
  const [product, currentInventory] = await Promise.all([
    db.from("products").select("id,sku,title,price,status,sent_target,tiny_product_id,listings(external_listing_id)").eq("id", productId).single().throwOnError(),
    db.from("estoque").select("estoque_fisico").eq("product_id", productId).maybeSingle().throwOnError()
  ]);
  const awaitingPrice = ["pending_price", "manual_price"].includes(product.data.status);
  if (awaitingPrice && price <= 0) redirect(`/produtos?erro=${encodeURIComponent("Informe um preço maior que zero para liberar o produto para envio.")}`);
  const linked = Boolean(product.data.sent_target || product.data.tiny_product_id || product.data.listings?.some(item => item.external_listing_id));
  const priceChanged = Math.abs(Number(product.data.price || 0) - price) >= 0.005;
  const titleChanged = product.data.title !== title;
  const stockChanged = Number(currentInventory.data?.estoque_fisico || 0) !== stock;
  const attributesChanged = priceChanged || titleChanged || awaitingPrice;
  let availableStock = stock;
  if (priceChanged || titleChanged || awaitingPrice) {
    await db.from("products").update({ ...(priceChanged ? { price } : {}), ...(awaitingPrice ? { status: "draft", price_evaluation_status: "MANUAL", price_evaluated_at: new Date().toISOString(), price_evaluation_error: null } : {}), ...(titleChanged ? { title } : {}), updated_at: new Date().toISOString() }).eq("id", productId).throwOnError();
  }
  await db.from("estoque").upsert({ product_id: productId, sku: product.data.sku }, { onConflict: "product_id" }).throwOnError();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (stockChanged) {
    const adjusted = await db.rpc("set_physical_inventory_manual", {
      p_product_id: productId, p_quantity: stock, p_actor_user_id: user.id, p_actor_name: user.name
    }).throwOnError();
    availableStock = Number(adjusted.data ?? stock);
    if (!sendAfterSave && !attributesChanged) await syncListingsStock(productId, availableStock, { sourceType: "product_update" }, false);
  }
  if (!sendAfterSave && attributesChanged && product.data.tiny_product_id) {
    await enqueueOutgoingActivity({ destination: "tiny", activityType: "listing_update", productId,
      sku: product.data.sku, productName: title, listingId: String(product.data.tiny_product_id), previousData: {},
      requestedData: { useCurrentProductData: true }, sourceType: "product_update", sourceId: productId });
  }
  if (!sendAfterSave && attributesChanged) {
    if (availableStock > 0) {
      await enqueueDirectListingUpdates(productId, undefined, false, { attributes: true, stock: availableStock });
      await db.from("products").update({ marketplace_update_pending: false }).eq("id", productId).throwOnError();
    } else {
      await db.from("products").update({ marketplace_update_pending: true }).eq("id", productId).throwOnError();
    }
  }
  if (sendAfterSave) {
    let result: Awaited<ReturnType<typeof sendProductToConfiguredTarget>>;
    try {
      result = await sendProductToConfiguredTarget(productId);
    } catch (error) {
      revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
      redirect(withMessage(returnTo, "erro", `Os dados foram salvos no sistema, mas o envio falhou: ${error instanceof Error ? error.message : String(error)}`));
    }
    revalidatePath("/"); revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
    waitUntil(drainOutgoingActivities());
    const message = result.ok ? `Dados atualizados e ${result.message}` : `Dados atualizados, mas o envio não foi enfileirado: ${result.message}`;
    redirect(result.ok && result.activityIds?.length
      ? withMessage(withMessage(returnTo, "fila", result.activityIds.join(",")), "aguardando", message)
      : withMessage(returnTo, result.ok ? "sucesso" : "erro", message));
  }
  waitUntil(drainOutgoingActivities());
  revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
  redirect(withMessage(returnTo, "sucesso", linked ? "Dados salvos e atualizações enviadas para a fila." : "Produto atualizado com sucesso."));
}

function safeProductsReturn(value: string) { return value.startsWith("/produtos") && !value.startsWith("//") ? value : "/produtos"; }
function withMessage(path: string, key: string, message: string) { return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`; }

export async function updateProductDetailsAction(formData: FormData) {
  const productId = String(formData.get("productId") || "");
  const text = (key: string) => String(formData.get(key) || "").trim();
  const number = (key: string) => Number(text(key).replace(",", "."));
  const currency = (key: string) => Number(text(key).replace(/\./g, "").replace(",", "."));
  const sku = text("sku"); const title = text("title"); const description = text("description");
  const redirectTo = text("redirectTo");
  const sendAfterSave = text("intent") === "send";
  const returnTo = safeProductsReturn(text("returnTo") || "/produtos");
  const detailError = (message: string) => `/produtos/${productId}?returnTo=${encodeURIComponent(returnTo)}&editar=1&erro=${encodeURIComponent(message)}`;
  const typeCode = text("typeCode"); const brandCode = text("brandCode"); const specialCode = text("specialCode") || null;
  const model = text("model"); const version = text("version") || null; const boardCode = text("boardCode");
  const price = currency("price"); const physicalStock = Math.trunc(number("physicalStock"));
  const productCondition = text("productCondition") === "new" ? "new" : "used";
  const measures = { height: number("height"), width: number("width"), length: number("length"), weight_net: number("weightNet"), weight_gross: number("weightGross") };
  if (!productId || !sku || !title || title.length > 60 || !description || model.length < 2 || !typeCode || typeCode === "OT" || !brandCode || brandCode === "NI" || !Number.isFinite(price) || price < 0 || !Number.isInteger(physicalStock) || physicalStock < 0 || Object.values(measures).some(value => !Number.isFinite(value) || value < 0)) {
    redirect(detailError("Preencha os campos obrigatórios com valores válidos."));
  }
  const db = supabaseAdmin();
  const current = await db.from("products").select("*,product_images(id,original_name,url,cloudinary_url,cloudinary_public_id,position,bytes,width_px,height_px)").eq("id", productId).single().throwOnError();
  const titleChanged = String(current.data.title || "") !== title;
  const requestedInternalCategory = text("marketplaceCategory");
  const typeConfiguration = await db.from("config_types").select("marketplace_category,marketplace_active_attributes").eq("code", typeCode).maybeSingle().throwOnError();
  const marketplaceCategory = typeCode === "OT" ? requestedInternalCategory : String(typeConfiguration.data?.marketplace_category || "").trim();
  const mapping = marketplaceCategory ? await db.from("marketplace_category_mappings").select("*").eq("internal_category", marketplaceCategory).maybeSingle().throwOnError() : { data: null };
  const definitions = structuredClone((mapping.data?.attribute_definitions || {}) as MarketplaceDefinitions);
  const activeAttributes = typeConfiguration.data?.marketplace_active_attributes as Partial<Record<"mercado_livre" | "shopee", string[]>> | null;
  const [marketplaceLinks, listingLinks] = await Promise.all([
    db.from("product_marketplaces").select("marketplace,status_anuncio,raw_data").eq("product_id", productId)
      .eq("existe_no_marketplace", true).not("marketplace_product_id", "is", null).order("updated_at").throwOnError(),
    db.from("listings").select("marketplace").eq("product_id", productId).not("external_listing_id", "is", null).throwOnError()
  ]);
  const categoryOverrides = new Set<string>();
  for (const marketplace of ["mercado_livre", "shopee"] as const) {
    const activeLink = marketplaceLinks.data.find(row => String(row.marketplace) === marketplace
      && ["active", "normal"].includes(String(row.status_anuncio || "").toLowerCase()));
    const actualCategoryId = String((activeLink?.raw_data as any)?.category_id || "");
    const defaultCategoryId = String(mapping.data?.[`${marketplace}_code`] || "");
    if (!actualCategoryId || actualCategoryId === defaultCategoryId) continue;
    const categoryName = await getMarketplaceCategoryPath(marketplace, actualCategoryId).catch(() => "");
    definitions[marketplace] = await fetchMarketplaceCategoryDefinition(marketplace, actualCategoryId, categoryName);
    categoryOverrides.add(marketplace);
  }
  const activeDefinitions: MarketplaceDefinitions = Object.fromEntries(
    (["mercado_livre", "shopee"] as const).map(marketplace => [marketplace, definitions[marketplace] ? { ...definitions[marketplace], attributes: categoryOverrides.has(marketplace)
      ? Object.fromEntries(Object.entries(definitions[marketplace]!.attributes || {}).filter(([, attribute]) => attribute.required && !attribute.systemSource))
      : activeAttributes?.[marketplace] === undefined ? definitions[marketplace]!.attributes : Object.fromEntries(Object.entries(definitions[marketplace]!.attributes || {}).filter(([id]) => activeAttributes[marketplace]!.includes(id))) } : undefined])
  ) as MarketplaceDefinitions;
  const boardCodeRequired = (["mercado_livre", "shopee"] as const).some(marketplace => Object.values(activeDefinitions[marketplace]?.attributes || {}).some(attribute => attribute.systemSource === "board_code" && attribute.required));
  if (boardCodeRequired && boardCode.length < 2) redirect(detailError("Código da placa é obrigatório para a integração selecionada e deve ter no mínimo 2 caracteres."));
  const currentCategories = (current.data.marketplace_categories || {}) as Record<string, any>;
  const marketplaceCategories: Record<string, any> = structuredClone(currentCategories);
  marketplaceCategories.internal_category = marketplaceCategory;
  const marketplaceAttributes: MarketplaceValues = structuredClone((current.data.marketplace_attributes || {}) as MarketplaceValues);
  const linkedMarketplaces = new Set([...marketplaceLinks.data, ...listingLinks.data].map(row => String(row.marketplace)));
  for (const marketplace of ["mercado_livre", "shopee"] as const) {
    if (linkedMarketplaces.has(marketplace)) continue;
    const categoryId = text(marketplace === "mercado_livre" ? "mercadoLivreCategoryId" : "shopeeCategoryId");
    const categoryName = text(marketplace === "mercado_livre" ? "mercadoLivreCategoryName" : "shopeeCategoryName");
    if (!categoryId) {
      delete marketplaceCategories[marketplace];
      delete marketplaceAttributes[marketplace];
      continue;
    }
    const previousId = String(marketplaceCategories[marketplace]?.categoryId || "");
    marketplaceCategories[marketplace] = { categoryId, categoryName, source: "product", attributes: {} };
    if (previousId !== categoryId) marketplaceAttributes[marketplace] = { categoryId, attributes: {} };
    marketplaceAttributes[marketplace] ||= { categoryId, attributes: {} };
    marketplaceAttributes[marketplace]!.categoryId = categoryId;
  }
  for (const [key, raw] of formData.entries()) {
    const match = key.match(/^productAttribute\.(mercado_livre|shopee)\.([^\.]+)\.(valueId|valueName|unit)$/);
    if (!match) continue;
    const [, marketplace, attributeId, property] = match;
    const group = marketplaceAttributes[marketplace as "mercado_livre" | "shopee"] ||= { categoryId: "", attributes: {} };
    const attribute = group.attributes[attributeId] ||= {};
    const value = String(raw || "").trim();
    if (value) (attribute as any)[property] = value; else delete (attribute as any)[property];
    if (property === "valueId" && value) {
      const option = definitions[marketplace as "mercado_livre" | "shopee"]?.attributes?.[attributeId]?.options?.find(item => item.id === value);
      if (option) attribute.valueName = option.originalName || option.name;
    }
  }
  const missing = validateRequiredAttributes(activeDefinitions, marketplaceAttributes);
  if (missing.length) {
    const grouped = ["mercado_livre", "shopee"].map(marketplace => {
      const names = missing.filter(item => item.marketplace === marketplace).map(item => item.name);
      return names.length ? `${marketplace === "shopee" ? "Shopee" : "Mercado Livre"}: ${names.join(", ")}` : "";
    }).filter(Boolean).join(". ");
    redirect(detailError(`Não foi possível salvar. Preencha os campos obrigatórios. ${grouped}`));
  }
  const imageSequence = text("imageOrder").split(",").filter(Boolean);
  const keptIds = imageSequence.filter(token => token.startsWith("existing:")).map(token => token.slice("existing:".length));
  const newKeys = imageSequence.filter(token => token.startsWith("new:")).map(token => token.slice("new:".length));
  const remoteKeys = imageSequence.filter(token => token.startsWith("remote:")).map(token => token.slice("remote:".length));
  const existingImages = (current.data.product_images || []) as Array<{ id: string; original_name: string; url?: string | null; cloudinary_url?: string | null; cloudinary_public_id?: string | null; position: number; bytes?: number | null; width_px?: number | null; height_px?: number | null }>;
  type PreparedImage = { key: string; name: string; url: string; publicId: string; cloudName: string; bytes: number; width: number; height: number; position: number };
  let preparedImages: PreparedImage[] = [];
  try { preparedImages = JSON.parse(text("preparedImages") || "[]") as PreparedImage[]; } catch { redirect(detailError("Os dados das fotos processadas ficaram inconsistentes. Envie as fotos novamente.")); }
  if (imageSequence.length === 0) redirect(detailError("Preencha os campos obrigatórios: adicione pelo menos a Foto 1."));
  if (imageSequence.length > 6) redirect(detailError("O produto pode possuir no máximo 6 fotos."));
  if (newKeys.length !== preparedImages.length || preparedImages.some(image => !image.key || !image.url || !image.publicId)) redirect(detailError("Aguarde o processamento de todas as fotos antes de salvar."));
  if (imageSequence.some(token => !token.startsWith("existing:") && !token.startsWith("new:") && !token.startsWith("remote:"))) redirect(detailError("A sequência das fotos ficou inconsistente. Abra novamente o produto antes de salvar."));
  const newImagesByKey = new Map(preparedImages.map(image => [image.key, image]));
  const remoteImagesByKey = new Map<string, { buffer: Buffer; name: string }>();
  if (remoteKeys.length) {
    const recoveryMarketplace = text("recoveryMarketplace");
    const recoveryAccountId = text("recoveryAccountId");
    const recoveryListingId = text("recoveryListingId");
    if (!(["mercado_livre", "shopee"] as string[]).includes(recoveryMarketplace) || !recoveryAccountId || !recoveryListingId) redirect(detailError("A origem das fotos recuperadas não foi identificada. Abra novamente o produto."));
    try {
      const urls = await resolveMarketplaceRecoveryImageUrls({ productId, marketplace: recoveryMarketplace as "mercado_livre" | "shopee", accountId: recoveryAccountId, listingId: recoveryListingId });
      for (const key of remoteKeys) {
        const index = Number(key);
        const url = urls[index];
        if (!Number.isInteger(index) || index < 0 || !url) throw new Error("Uma foto recuperada não está mais disponível no anúncio de origem.");
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`Não foi possível baixar uma foto recuperada (${response.status}).`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > 8 * 1024 * 1024) throw new Error("Uma foto recuperada excede 8 MB antes do processamento.");
        remoteImagesByKey.set(key, { buffer, name: `marketplace-${String(index + 1).padStart(2, "0")}.jpg` });
      }
    } catch (error) {
      redirect(detailError(`Não foi possível recuperar as fotos do anúncio: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  const removed = existingImages.filter(image => !keptIds.includes(image.id));
  const previousImageSequence = [...existingImages]
    .sort((left, right) => left.position - right.position)
    .map(image => `existing:${image.id}`);
  const imagesChanged = preparedImages.length > 0
    || remoteKeys.length > 0
    || removed.length > 0
    || imageSequence.some((token, index) => token !== previousImageSequence[index]);

  try {
    await db.from("products").update({ sku, title, description, model, version, board_code: boardCode || null, price, type_code: typeCode, brand_code: brandCode, special_code: specialCode, product_condition: productCondition, marketplace_categories: marketplaceCategories, marketplace_attributes: marketplaceAttributes, ...measures, updated_at: new Date().toISOString() }).eq("id", productId).throwOnError();
    await db.from("listings").update({ external_sku: sku }).eq("product_id", productId).throwOnError();
    await db.from("product_marketplaces").update({ sku, updated_at: new Date().toISOString() }).eq("product_id", productId).throwOnError();
    await db.from("estoque").update({ sku }).eq("product_id", productId).throwOnError();
    const currentInventory = await db.from("estoque").select("estoque_fisico,estoque_disponivel").eq("product_id", productId).single().throwOnError();
    let availableStock = Number(currentInventory.data.estoque_disponivel);
    if (Number(currentInventory.data.estoque_fisico) !== physicalStock) {
      const user = await getCurrentUser();
      if (!user) redirect("/login");
      const adjusted = await db.rpc("set_physical_inventory_manual", { p_product_id: productId, p_quantity: physicalStock, p_actor_user_id: user.id, p_actor_name: user.name }).throwOnError();
      availableStock = Number(adjusted.data ?? availableStock);
    }

    for (const image of existingImages) await db.from("product_images").update({ position: 1000 + image.position }).eq("id", image.id).throwOnError();
    for (const image of removed) {
      await db.from("product_images").delete().eq("id", image.id).throwOnError();
      await deleteCloudinaryResource(image.cloudinary_public_id);
    }

    const existingById = new Map(existingImages.map(image => [image.id, image]));
    for (const [index, token] of imageSequence.entries()) {
      const position = index + 1;
      if (token.startsWith("new:")) {
        const entry = newImagesByKey.get(token.slice("new:".length));
        if (!entry) throw new Error("Nova foto não localizada na sequência final.");
        let finalImage = entry;
        if (entry.position !== position) {
          const source = await fetch(entry.url, { cache: "no-store" });
          if (!source.ok) throw new Error(`Não foi possível ajustar a posição da foto ${entry.name}.`);
          const upload = await uploadProductImageToCloudinary({ buffer: Buffer.from(await source.arrayBuffer()), fileName: entry.name,
            sku, typeCode, brandCode, model, boardCode, position });
          finalImage = { ...entry, url: upload.cloudinaryUrl, publicId: upload.publicId, cloudName: upload.cloudName, bytes: upload.bytes, width: upload.width, height: upload.height, position };
          await deleteCloudinaryResource(entry.publicId).catch(() => undefined);
        }
        const errors = validateMarketplaceImage(finalImage);
        if (errors.length) throw new Error(`A foto ${entry.name} não ficou compatível após o tratamento: ${errors.join(" ")}`);
        await db.from("product_images").insert({ product_id: productId, original_name: entry.name, url: finalImage.url, cloudinary_url: finalImage.url,
          cloudinary_public_id: finalImage.publicId, cloudinary_cloud_name: finalImage.cloudName, bytes: finalImage.bytes, width_px: finalImage.width, height_px: finalImage.height, position, status: "uploaded" }).throwOnError();
        continue;
      }
      if (token.startsWith("remote:")) {
        const recovered = remoteImagesByKey.get(token.slice("remote:".length));
        if (!recovered) throw new Error("Foto recuperada não localizada na sequência final.");
        const upload = await uploadProductImageToCloudinary({ buffer: recovered.buffer, fileName: recovered.name, sku, typeCode, brandCode, model, boardCode, position });
        await db.from("product_images").insert({ product_id: productId, original_name: recovered.name, url: upload.cloudinaryUrl, cloudinary_url: upload.cloudinaryUrl, cloudinary_public_id: upload.publicId, cloudinary_cloud_name: upload.cloudName, bytes: upload.bytes, width_px: upload.width, height_px: upload.height, position, status: "uploaded" }).throwOnError();
        continue;
      }
      const id = token.slice("existing:".length);
      const image = existingById.get(id);
      if (!image) throw new Error("Foto existente não localizada na sequência final.");
      const hasEffectiveCloudinaryLink = Boolean(image.cloudinary_public_id && image.cloudinary_url);
      const needsReprocessing = image.position !== position || !hasEffectiveCloudinaryLink
        || validateMarketplaceImage({ width: Number(image.width_px), height: Number(image.height_px), bytes: Number(image.bytes) }).length > 0;
      if (!needsReprocessing) {
        await db.from("product_images").update({ position }).eq("id", id).eq("product_id", productId).throwOnError();
        continue;
      }
      const sourceUrl = image.cloudinary_url || image.url;
      if (!sourceUrl) throw new Error(`A foto ${image.original_name} não possui um arquivo acessível para reprocessamento.`);
      const source = await fetch(sourceUrl, { cache: "no-store" });
      if (!source.ok) throw new Error(`Não foi possível baixar a foto ${image.original_name} para reprocessamento (${source.status}).`);
      const buffer = Buffer.from(await source.arrayBuffer());
      if (buffer.byteLength > 8 * 1024 * 1024) throw new Error(`A imagem ${image.original_name} excede 8 MB antes do processamento.`);
      const upload = await uploadProductImageToCloudinary({ buffer, fileName: image.original_name, sku, typeCode, brandCode, model, boardCode, position });
      await db.from("product_images").update({ url: upload.cloudinaryUrl, cloudinary_url: upload.cloudinaryUrl, cloudinary_public_id: upload.publicId, cloudinary_cloud_name: upload.cloudName, bytes: upload.bytes, width_px: upload.width, height_px: upload.height, position, status: "uploaded" }).eq("id", id).eq("product_id", productId).throwOnError();
      if (image.cloudinary_public_id && image.cloudinary_public_id !== upload.publicId) await deleteCloudinaryResource(image.cloudinary_public_id);
    }

    if (current.data.tiny_product_id) {
      await enqueueOutgoingActivity({ destination: "tiny", activityType: "listing_update", productId, sku, productName: title,
        listingId: String(current.data.tiny_product_id), requestedData: { reason: "product_saved", imagesChanged } });
    }
    if (availableStock > 0) {
      await enqueueDirectListingUpdates(productId, undefined, false, { title: titleChanged, price: true, attributes: true, images: imagesChanged, stock: availableStock });
      await db.from("products").update({ marketplace_update_pending: false }).eq("id", productId).throwOnError();
    } else {
      // O Mercado Livre rejeita atualizacoes completas de anuncios sem saldo.
      // Conservamos a intencao para publicar todos os atributos no primeiro
      // crescimento de estoque, sem fazer uma chamada externa que ja falharia.
      await db.from("products").update({ marketplace_update_pending: true }).eq("id", productId).throwOnError();
    }
    waitUntil(drainOutgoingActivities());
  } catch (error) {
    revalidatePath(`/produtos/${productId}`);
    redirect(detailError(`Os dados foram processados, mas a atualização não foi concluída: ${error instanceof Error ? error.message : String(error)}`));
  }
  revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
  if (sendAfterSave) {
    const detailReturn = `/produtos/${productId}?returnTo=${encodeURIComponent(returnTo)}`;
    let result: Awaited<ReturnType<typeof sendProductToConfiguredTarget>>;
    try {
      result = await sendProductToConfiguredTarget(productId);
    } catch (error) {
      redirect(withMessage(detailReturn, "erro", `Os dados foram salvos no sistema, mas o envio falhou: ${error instanceof Error ? error.message : String(error)}`));
    }
    revalidatePath("/"); revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
    waitUntil(drainOutgoingActivities());
    const message = result.ok ? `Dados atualizados e ${result.message}` : `Dados atualizados, mas o envio não foi enfileirado: ${result.message}`;
    redirect(result.ok && result.activityIds?.length
      ? withMessage(withMessage(detailReturn, "fila", result.activityIds.join(",")), "aguardando", message)
      : withMessage(detailReturn, result.ok ? "sucesso" : "erro", message));
  }
  redirect(redirectTo.startsWith("/") && !redirectTo.startsWith("//")
    ? redirectTo
    : `/produtos/${productId}?sucesso=${encodeURIComponent("Produto salvo e integrações atualizadas com sucesso.")}`);
}
