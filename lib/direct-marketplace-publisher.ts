import { drainOutgoingActivities, enqueueOutgoingActivity } from "./outgoing-activities";
import { supabaseAdmin } from "./supabase-admin";
import { htmlToPlainText } from "./html-to-plain-text";
import { buildProductDescription } from "./dynamic-product-description";

export async function publishProductDirectly(productId: string, processImmediately = true) {
  const db = supabaseAdmin();
  const [productResult, inventoryResult, accountsResult, listingLinks, marketplaceLinks] = await Promise.all([
    db.from("products").select("*,product_images(position,url,cloudinary_url)").eq("id", productId).single().throwOnError(),
    db.from("estoque").select("estoque_disponivel").eq("product_id", productId).single().throwOnError(),
    db.from("config_marketplace_accounts").select("id,name,marketplace").in("marketplace", ["mercado_livre", "shopee"]).eq("active", true).throwOnError(),
    db.from("listings").select("marketplace_account_id,external_listing_id").eq("product_id", productId).not("external_listing_id", "is", null).throwOnError(),
    db.from("product_marketplaces").select("marketplace_account_id,marketplace_product_id").eq("product_id", productId).eq("existe_no_marketplace", true).not("marketplace_product_id", "is", null).throwOnError()
  ]);
  const product = productResult.data;
  const linkedAccountIds = new Set([
    ...(listingLinks.data || []).filter(link => link.external_listing_id).map(link => String(link.marketplace_account_id)),
    ...(marketplaceLinks.data || []).filter(link => link.marketplace_product_id).map(link => String(link.marketplace_account_id))
  ]);
  const missingAccounts = (accountsResult.data || []).filter(account => !linkedAccountIds.has(String(account.id)));
  if (!(accountsResult.data || []).length) throw new Error("Nenhuma conta ativa de marketplace configurada.");
  if (!missingAccounts.length) return [];
  const [brandResult, typeResult, specialResult] = await Promise.all([
    db.from("config_brands").select("name").eq("code", product.brand_code).maybeSingle().throwOnError(),
    db.from("config_types").select("description,description_template").eq("code", product.type_code).maybeSingle().throwOnError(),
    db.from("config_specials").select("include_description,remove_description").eq("code", product.special_code || "__none__").maybeSingle().throwOnError(),
  ]);
  const categories = (product.marketplace_categories || {}) as Record<string, any>;
  const storedAttributes = (product.marketplace_attributes || {}) as Record<string, any>;
  const categoryId = String(categories.mercado_livre?.categoryId || "");
  if (missingAccounts.some(account => account.marketplace === "mercado_livre") && !categoryId) throw new Error(`Categoria Mercado Livre nao mapeada para o tipo ${product.type_code}.`);
  const productCondition = product.product_condition === "new" ? "new" : "used";
  const shopeeCondition = productCondition === "new" ? "NEW" : "USED";
  const description = htmlToPlainText(buildProductDescription(product, typeResult.data, brandResult.data, specialResult.data));
  const partNumber = String(product.board_code || product.model || "").trim();
  const devicePartNumber = String(product.board_code || "").trim();
  const images = (product.product_images || []).sort((a: any,b: any) => a.position-b.position)
    .map((image: any) => image.cloudinary_url || image.url).filter(Boolean);
  const activityIds: string[] = [];
  for (const account of missingAccounts) {
    if (account.marketplace === "shopee") {
      const shopeeCategoryId = Number(categories.shopee?.categoryId || 0);
      if (!shopeeCategoryId) throw new Error(`Categoria Shopee nao mapeada para o tipo ${product.type_code}.`);
      const shopeeAttributes = toShopeeAttributes(storedAttributes.shopee?.attributes || {});
      activityIds.push(await enqueueOutgoingActivity({ destination: "shopee", activityType: "listing_create", productId,
        sku: String(product.sku), productName: String(product.title), accountId: String(account.id), requestedData: {
          payload: { item_name: String(product.title).slice(0, 120), description,
            item_sku: String(product.sku), category_id: shopeeCategoryId, original_price: Number(product.price),
            seller_stock: [{ stock: Number(inventoryResult.data.estoque_disponivel || 0) }], weight: Number(product.weight_gross || 0.4),
            dimension: { package_length: Number(product.length || 1), package_width: Number(product.width || 1), package_height: Number(product.height || 1) },
            condition: shopeeCondition, gtin_code: "00", brand: { brand_id: 0, original_brand_name: String(brandResult.data?.name || "Sem marca") },
            attribute_list: shopeeAttributes }, imageUrls: images, accountName: account.name
        }, sourceType: "direct_publish", sourceId: productId }));
      continue;
    }
    activityIds.push(await enqueueOutgoingActivity({
      destination: "mercado_livre", activityType: "listing_create", productId, sku: String(product.sku),
      productName: String(product.title), accountId: String(account.id), requestedData: {
        payload: {
          family_name: String(product.title).slice(0, 60), category_id: categoryId, price: Number(product.price), currency_id: "BRL",
          available_quantity: Number(inventoryResult.data.estoque_disponivel || 0), buying_mode: "buy_it_now", condition: productCondition,
          listing_type_id: "gold_special", pictures: images.map((source: string) => ({ source })),
          shipping: { mode: "me2", local_pick_up: false, free_shipping: false },
          sale_terms: toMercadoLivreSaleTerms(storedAttributes.mercado_livre?.attributes || {}),
          attributes: [
            { id: "SELLER_SKU", value_name: String(product.sku) }, { id: "BRAND", value_name: String(brandResult.data?.name || "") },
            { id: "MODEL", value_name: String(product.model || "") }, { id: "PART_NUMBER", value_name: partNumber },
            ...(devicePartNumber ? [{ id: "DEVICE_PART_NUMBER", value_name: devicePartNumber }] : []),
            { id: "ITEM_CONDITION", value_id: productCondition === "new" ? "2230284" : "2230581", value_name: productCondition === "new" ? "Novo" : "Usado" },
            { id: "SELLER_PACKAGE_HEIGHT", value_name: `${Number(product.height || 0)} cm` },
            { id: "SELLER_PACKAGE_WIDTH", value_name: `${Number(product.width || 0)} cm` },
            { id: "SELLER_PACKAGE_LENGTH", value_name: `${Number(product.length || 0)} cm` },
            { id: "SELLER_PACKAGE_WEIGHT", value_name: `${Math.round(Number(product.weight_gross || 0) * 1000)} g` },
            ...toMercadoLivreAttributes(storedAttributes.mercado_livre?.attributes || {}, CREATE_SYSTEM_ATTRIBUTES)
          ]
        },
        description,
        accountName: account.name
      }, sourceType: "direct_publish", sourceId: productId
    }));
  }
  if (!processImmediately) return activityIds.map(id => ({ id, status: "queued", processing_error: null }));
  await drainOutgoingActivities();
  const result = await db.from("outgoing_marketplace_activities").select("id,status,processing_error,confirmed_data")
    .in("id", activityIds).throwOnError();
  return result.data || [];
}

export async function enqueueDirectListingUpdates(productId: string, target?: { accountId?: string; listingId?: string; marketplace?: string }, processImmediately = true, changes?: { title?: boolean; price?: boolean; attributes?: boolean; stock?: number }) {
  const db = supabaseAdmin();
  const [productResult, linksResult, listingLinksResult] = await Promise.all([
    db.from("products").select("id,sku,title,description,price,type_code,special_code,product_condition,marketplace_categories,marketplace_attributes").eq("id", productId).single().throwOnError(),
    db.from("product_marketplaces").select("marketplace,marketplace_account_id,marketplace_product_id,titulo_marketplace,valor_marketplace")
      .eq("product_id", productId).eq("existe_no_marketplace", true).throwOnError(),
    db.from("listings").select("marketplace,marketplace_account_id,external_listing_id,price")
      .eq("product_id", productId).not("external_listing_id", "is", null).throwOnError()
  ]);
  const links = new Map<string, { marketplace: string; marketplace_account_id: string; marketplace_product_id: string; titulo_marketplace?: string | null; valor_marketplace?: number | null }>();
  for (const link of linksResult.data || []) {
    if (!link.marketplace_account_id || !link.marketplace_product_id) continue;
    links.set(`${link.marketplace_account_id}:${link.marketplace_product_id}`, link as any);
  }
  for (const link of listingLinksResult.data || []) {
    if (!link.marketplace_account_id || !link.external_listing_id) continue;
    const key = `${link.marketplace_account_id}:${link.external_listing_id}`;
    if (!links.has(key)) links.set(key, { marketplace: String(link.marketplace), marketplace_account_id: String(link.marketplace_account_id),
      marketplace_product_id: String(link.external_listing_id), valor_marketplace: Number(link.price || 0) });
  }
  if (!links.size) return [];
  if (changes && !changes.title && !changes.price && !changes.attributes) return [];
  const product = productResult.data;
  const fullAttributeUpdate = !changes || Boolean(changes.attributes);
  const [inventoryResult] = fullAttributeUpdate ? await Promise.all([
    db.from("estoque").select("estoque_disponivel").eq("product_id", productId).maybeSingle().throwOnError()
  ]) : [{ data: null }];
  const stock = Math.max(0, Number(changes?.stock ?? inventoryResult.data?.estoque_disponivel ?? 0));
  const storedAttributes = (product.marketplace_attributes || {}) as Record<string, any>;
  const productCondition = product.product_condition === "new" ? "new" : "used";
  const ids = [];
  for (const link of [...links.values()].filter(link =>
    (!target?.accountId || link.marketplace_account_id === target.accountId)
    && (!target?.listingId || link.marketplace_product_id === target.listingId)
    && (!target?.marketplace || link.marketplace === target.marketplace)
  )) {
    const destination = link.marketplace as "mercado_livre" | "shopee";
    const payload = changes && !changes.attributes
      ? destination === "mercado_livre"
        ? { ...(changes.price ? { price: Number(product.price) } : {}) }
        : { ...(changes.title ? { item_name: String(product.title).slice(0, 120) } : {}), ...(changes.price ? { original_price: Number(product.price) } : {}) }
      : destination === "mercado_livre"
        ? { price: Number(product.price), available_quantity: stock, condition: productCondition, attributes: [{ id: "ITEM_CONDITION", value_id: productCondition === "new" ? "2230284" : "2230581", value_name: productCondition === "new" ? "Novo" : "Usado" }, ...toMercadoLivreAttributes(storedAttributes.mercado_livre?.attributes || {})], sale_terms: toMercadoLivreSaleTerms(storedAttributes.mercado_livre?.attributes || {}) }
        : { item_name: String(product.title).slice(0, 120), description: String(product.description || "").replace(/<br\s*\/?\s*>/gi, "\n"), original_price: Number(product.price), condition: productCondition === "new" ? "NEW" : "USED", gtin_code: "00",
          seller_stock: [{ stock }],
          attribute_list: toShopeeAttributes(storedAttributes.shopee?.attributes || {}) };
    ids.push(await enqueueOutgoingActivity({ destination, activityType: "listing_update", productId, sku: product.sku,
      productName: product.title, accountId: link.marketplace_account_id, listingId: link.marketplace_product_id,
      previousData: { title: link.titulo_marketplace, price: link.valor_marketplace }, requestedData: { payload,
        ...(fullAttributeUpdate && destination === "mercado_livre" ? { description: htmlToPlainText(String(product.description || "")) } : {}),
        ...(fullAttributeUpdate ? { stock } : {}) },
      sourceType: "product_update", sourceId: productId }));
  }
  if (processImmediately) await drainOutgoingActivities();
  return ids;
}

function toShopeeAttributes(values: Record<string, any>) {
  return Object.entries(values).flatMap(([id, value]) => {
    const ids = value.valueIds?.length ? value.valueIds : [value.valueId].filter(Boolean);
    const names = value.valueNames?.length ? value.valueNames : [value.valueName].filter(Boolean);
    const count = Math.max(ids.length, names.length);
    if (!count) return [];
    return [{ attribute_id: Number(id), attribute_value_list: Array.from({ length: count }, (_, index) => ({
      value_id: Number(ids[index] || 0), original_value_name: String(names[index] || ""), ...(value.unit ? { value_unit: value.unit } : {})
    })) }];
  });
}

const CREATE_SYSTEM_ATTRIBUTES = new Set([
  "WARRANTY_TYPE", "WARRANTY_TIME", "SELLER_SKU", "BRAND", "MODEL", "PART_NUMBER",
  "DEVICE_PART_NUMBER", "ITEM_CONDITION", "SELLER_PACKAGE_HEIGHT", "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH", "SELLER_PACKAGE_WEIGHT"
]);

function toMercadoLivreAttributes(values: Record<string, any>, excludedIds?: ReadonlySet<string>) {
  const result: any[] = [];
  const systemManaged = excludedIds || new Set(["WARRANTY_TYPE", "WARRANTY_TIME", "DEVICE_PART_NUMBER", "ITEM_CONDITION"]);
  for (const [id, value] of Object.entries(values)) {
    if (systemManaged.has(id)) continue;
    if (value.valueIds?.length || value.valueNames?.length) result.push({ id, values: (value.valueIds || value.valueNames || []).map((_: unknown, index: number) => ({ value_id: value.valueIds?.[index], value_name: value.valueNames?.[index] })).filter((item: any) => item.value_id || item.value_name) });
    else if (value.valueId || value.valueName) result.push({ id, ...(value.valueId ? { value_id: value.valueId } : {}), ...(value.valueName ? { value_name: value.valueName } : {}) });
  }
  return result;
}

function toMercadoLivreSaleTerms(values: Record<string, any>) {
  return ["WARRANTY_TYPE", "WARRANTY_TIME"].flatMap(id => {
    const value = values[id]; if (!value?.valueId && !value?.valueName) return [];
    return [{ id, ...(value.valueId ? { value_id: value.valueId } : {}), ...(value.valueName ? { value_name: value.valueName } : {}) }];
  });
}
