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
import { createTinyProduct, deactivateTinyProductById, updateTinyProduct } from "@/lib/tiny";
import { deleteCloudinaryResource, uploadProductImageToCloudinary } from "@/lib/cloudinary";
import { synchronizeProductById } from "@/lib/product-point-sync";
import { cloneProduct } from "@/lib/product-cloner";
import { waitUntil } from "@vercel/functions";
import { validateRequiredAttributes, type MarketplaceDefinitions, type MarketplaceValues } from "@/lib/marketplace-attributes";

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
    await enqueueDirectListingUpdates(productId, undefined, false, { attributes: true, stock: availableStock });
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
  const sku = text("sku"); const title = text("title"); const description = text("description");
  const redirectTo = text("redirectTo");
  const returnTo = safeProductsReturn(text("returnTo") || "/produtos");
  const detailError = (message: string) => `/produtos/${productId}?returnTo=${encodeURIComponent(returnTo)}&editar=1&erro=${encodeURIComponent(message)}`;
  const typeCode = text("typeCode"); const brandCode = text("brandCode"); const specialCode = text("specialCode") || null;
  const productCondition = text("productCondition") === "new" ? "new" : "used";
  const measures = { height: number("height"), width: number("width"), length: number("length"), weight_net: number("weightNet"), weight_gross: number("weightGross") };
  if (!productId || !sku || !title || title.length > 60 || !description || !typeCode || typeCode === "OT" || !brandCode || brandCode === "NI" || Object.values(measures).some(value => !Number.isFinite(value) || value < 0)) {
    redirect(detailError("Preencha os campos obrigatórios com valores válidos."));
  }
  const db = supabaseAdmin();
  const current = await db.from("products").select("*,product_images(id,original_name,cloudinary_public_id,position)").eq("id", productId).single().throwOnError();
  const requestedInternalCategory = text("marketplaceCategory");
  const typeConfiguration = await db.from("config_types").select("marketplace_category,marketplace_active_attributes").eq("code", typeCode).maybeSingle().throwOnError();
  const marketplaceCategory = typeCode === "OT" ? requestedInternalCategory : String(typeConfiguration.data?.marketplace_category || "").trim();
  const mapping = marketplaceCategory ? await db.from("marketplace_category_mappings").select("*").eq("internal_category", marketplaceCategory).maybeSingle().throwOnError() : { data: null };
  const definitions = (mapping.data?.attribute_definitions || {}) as MarketplaceDefinitions;
  const activeAttributes = typeConfiguration.data?.marketplace_active_attributes as Partial<Record<"mercado_livre" | "shopee", string[]>> | null;
  const activeDefinitions: MarketplaceDefinitions = activeAttributes == null ? definitions : Object.fromEntries(
    (["mercado_livre", "shopee"] as const).map(marketplace => [marketplace, definitions[marketplace] ? { ...definitions[marketplace], attributes: activeAttributes[marketplace] === undefined ? definitions[marketplace]!.attributes : Object.fromEntries(Object.entries(definitions[marketplace]!.attributes || {}).filter(([id]) => activeAttributes[marketplace]!.includes(id))) } : undefined])
  ) as MarketplaceDefinitions;
  const currentCategories = (current.data.marketplace_categories || {}) as Record<string, any>;
  const marketplaceCategories: Record<string, any> = structuredClone(currentCategories);
  marketplaceCategories.internal_category = marketplaceCategory;
  const marketplaceAttributes: MarketplaceValues = structuredClone((current.data.marketplace_attributes || {}) as MarketplaceValues);
  const [marketplaceLinks, listingLinks] = await Promise.all([
    db.from("product_marketplaces").select("marketplace").eq("product_id", productId)
      .eq("existe_no_marketplace", true).not("marketplace_product_id", "is", null).throwOnError(),
    db.from("listings").select("marketplace").eq("product_id", productId).not("external_listing_id", "is", null).throwOnError()
  ]);
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
  const keptIds = text("imageOrder").split(",").filter(Boolean);
  const existingImages = (current.data.product_images || []) as Array<{ id: string; original_name: string; cloudinary_public_id?: string | null; position: number }>;
  const newImages = formData.getAll("newImages").filter(entry => entry instanceof File && entry.size > 0);
  if (keptIds.length === 0 && newImages.length === 0) redirect(detailError("Preencha os campos obrigatórios: adicione pelo menos a Foto 1."));
  const removed = existingImages.filter(image => !keptIds.includes(image.id));

  try {
    await db.from("products").update({ sku, title, description, type_code: typeCode, brand_code: brandCode, special_code: specialCode, product_condition: productCondition, marketplace_categories: marketplaceCategories, marketplace_attributes: marketplaceAttributes, ...measures, updated_at: new Date().toISOString() }).eq("id", productId).throwOnError();
    await db.from("listings").update({ external_sku: sku }).eq("product_id", productId).throwOnError();
    await db.from("product_marketplaces").update({ sku, updated_at: new Date().toISOString() }).eq("product_id", productId).throwOnError();
    await db.from("estoque").update({ sku }).eq("product_id", productId).throwOnError();

    for (const image of existingImages) await db.from("product_images").update({ position: 1000 + image.position }).eq("id", image.id).throwOnError();
    for (const [index, id] of keptIds.entries()) await db.from("product_images").update({ position: index + 1 }).eq("id", id).eq("product_id", productId).throwOnError();
    for (const image of removed) {
      await db.from("product_images").delete().eq("id", image.id).throwOnError();
      await deleteCloudinaryResource(image.cloudinary_public_id);
    }

    let position = keptIds.length + 1;
    for (const entry of newImages) {
      if (!(entry instanceof File) || entry.size === 0) continue;
      if (!entry.type.startsWith("image/") || entry.size > 8 * 1024 * 1024) throw new Error(`A imagem ${entry.name} deve ser JPG, PNG ou WebP e ter no máximo 8 MB.`);
      const upload = await uploadProductImageToCloudinary({ buffer: Buffer.from(await entry.arrayBuffer()), fileName: entry.name, sku, typeCode, brandCode, model: String(current.data.model || "PRODUTO"), boardCode: String(current.data.board_code || ""), position });
      await db.from("product_images").insert({ product_id: productId, original_name: entry.name, url: upload.cloudinaryUrl, cloudinary_url: upload.cloudinaryUrl, cloudinary_public_id: upload.publicId, bytes: upload.bytes, position, status: "uploaded" }).throwOnError();
      position += 1;
    }

    if (current.data.tiny_product_id) {
      try {
        await updateTinyProduct(productId, String(current.data.tiny_product_id));
      } catch (updateError) {
        await deactivateTinyProductById(String(current.data.tiny_product_id));
        const recreated = await createTinyProduct(productId);
        await db.from("products").update({ tiny_product_id: recreated.idProduto, sent_target: "TINY", status: "sent", sent_at: new Date().toISOString() }).eq("id", productId).throwOnError();
      }
    }
    await enqueueDirectListingUpdates(productId);
  } catch (error) {
    revalidatePath(`/produtos/${productId}`);
    redirect(detailError(`Os dados foram processados, mas a atualização não foi concluída: ${error instanceof Error ? error.message : String(error)}`));
  }
  revalidatePath("/produtos"); revalidatePath(`/produtos/${productId}`);
  redirect(redirectTo.startsWith("/") && !redirectTo.startsWith("//")
    ? redirectTo
    : `/produtos/${productId}?sucesso=${encodeURIComponent("Produto salvo e integrações atualizadas com sucesso.")}`);
}
