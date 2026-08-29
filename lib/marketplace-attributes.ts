import { getActiveMercadoLivreAccounts, getValidMercadoLivreAccessToken } from "./mercado-livre";
import { getActiveShopeeAccounts, getValidShopeeAccessToken } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { supabaseAdmin } from "./supabase-admin";
import { getMarketplaceCategoryPath } from "./marketplace-categories";

export type MarketplaceCode = "mercado_livre" | "shopee";
export type AttributeOption = { id: string; name: string; originalName?: string; unit?: string };
export type AttributeDefinition = {
  id: string;
  name: string;
  originalName: string;
  inputType: "text" | "number" | "select" | "combo" | "multi_select" | "multi_combo" | "boolean" | "date";
  required: boolean;
  conditionalRequired?: boolean;
  options: AttributeOption[];
  units?: string[];
  systemSource?: string;
  active: boolean;
};
export type AttributeValue = { valueId?: string; valueName?: string; valueIds?: string[]; valueNames?: string[]; unit?: string };
export type MarketplaceDefinitions = Partial<Record<MarketplaceCode, { categoryId: string; categoryName: string; attributes: Record<string, AttributeDefinition> }>>;
export type MarketplaceValues = Partial<Record<MarketplaceCode, { categoryId: string; attributes: Record<string, AttributeValue> }>>;

const SYSTEM_SOURCES: Record<string, string> = {
  BRAND: "brand", MODEL: "model", COMPATIBLE_MODEL: "model", BOARD_CODE: "board_code", DEVICE_PART_NUMBER: "board_code",
  SELLER_SKU: "sku", ITEM_CONDITION: "product_condition", CONDITION: "product_condition",
  TITLE: "title", DESCRIPTION: "description", SELLER_PACKAGE_HEIGHT: "height", SELLER_PACKAGE_WIDTH: "width",
  SELLER_PACKAGE_LENGTH: "length", SELLER_PACKAGE_WEIGHT: "weight_gross", "100942": "dimensions", "100413": "product_condition"
};

export async function syncCategoryAttributes(internalCategory: string) {
  const db = supabaseAdmin();
  const mapping = await db.from("marketplace_category_mappings").select("*").eq("internal_category", internalCategory).single().throwOnError();
  const current = (mapping.data.attribute_definitions || {}) as MarketplaceDefinitions;
  const definitions: MarketplaceDefinitions = { ...current };
  if (mapping.data.mercado_livre_code) definitions.mercado_livre = await fetchMercadoLivreDefinitions(String(mapping.data.mercado_livre_code), String(mapping.data.mercado_livre_description || ""));
  if (mapping.data.shopee_code) definitions.shopee = await fetchShopeeDefinitions(String(mapping.data.shopee_code), String(mapping.data.shopee_description || ""));
  await db.from("marketplace_category_mappings").update({ attribute_definitions: definitions, updated_at: new Date().toISOString() })
    .eq("internal_category", internalCategory).throwOnError();
  return definitions;
}

async function fetchMercadoLivreDefinitions(categoryId: string, categoryName: string) {
  const account = (await getActiveMercadoLivreAccounts())[0];
  const token = account ? await getValidMercadoLivreAccessToken(account) : "";
  const response = await fetch(`https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/attributes`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}, cache: "no-store"
  });
  const rows = await response.json();
  if (!response.ok || !Array.isArray(rows)) throw new Error(`Mercado Livre: nao foi possivel consultar os atributos de ${categoryId}.`);
  const attributes: Record<string, AttributeDefinition> = {};
  for (const row of rows as Array<Record<string, any>>) {
    const id = String(row.id || ""); if (!id) continue;
    attributes[id] = {
      id, name: String(row.name || id), originalName: String(row.name || id), inputType: mlInputType(row.value_type, row.tags),
      required: Boolean(row.tags?.required || row.tags?.catalog_required), conditionalRequired: Boolean(row.tags?.conditional_required),
      options: (row.values || []).map((value: any) => ({ id: String(value.id || ""), name: String(value.name || value.id || "") })),
      systemSource: SYSTEM_SOURCES[id], active: true
    };
  }
  return { categoryId, categoryName, attributes };
}

async function fetchShopeeDefinitions(categoryId: string, categoryName: string) {
  const account = (await getActiveShopeeAccounts())[0];
  if (!account) throw new Error("Conecte uma conta Shopee antes de atualizar os atributos.");
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error("Shop ID da Shopee ausente.");
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const response = await client.getAttributeTree(token, shopId, [categoryId], "pt-br");
  const category = ((response.response as any)?.list || []).find((item: any) => String(item.category_id) === categoryId) || {};
  const attributes: Record<string, AttributeDefinition> = {};
  for (const row of (category.attribute_tree || []) as Array<Record<string, any>>) {
    const id = String(row.attribute_id || ""); if (!id) continue;
    const translated = (row.multi_lang || []).find((entry: any) => String(entry.language).toLowerCase() === "pt-br")?.value;
    const mandatoryRegion = (row.attribute_info?.mandatory_region || []).map(String).map((item: string) => item.toUpperCase());
    attributes[id] = {
      id, name: String(translated || row.name || id), originalName: String(row.name || id), inputType: shopeeInputType(Number(row.attribute_info?.input_type || 3), id),
      required: Boolean(row.mandatory || mandatoryRegion.includes("BR")), options: (row.attribute_value_list || []).map((value: any) => ({
        id: String(value.value_id || "0"), name: String((value.multi_lang || []).find((entry: any) => String(entry.language).toLowerCase() === "pt-br")?.value || value.name || value.value_id), originalName: String(value.name || ""), unit: String(value.value_unit || "") || undefined
      })), units: (row.attribute_info?.attribute_unit_list || []).map(String), systemSource: SYSTEM_SOURCES[id], active: true
    };
  }
  return { categoryId, categoryName, attributes };
}

export async function fetchMarketplaceCategoryDefinition(marketplace: MarketplaceCode, categoryId: string, categoryName = "") {
  return marketplace === "mercado_livre"
    ? fetchMercadoLivreDefinitions(categoryId, categoryName)
    : fetchShopeeDefinitions(categoryId, categoryName);
}

export async function reconcileProductMarketplaceMetadata(
  productId: string,
  marketplace: MarketplaceCode,
  rawData: Record<string, unknown>
) {
  const db = supabaseAdmin();
  const productResult = await db.from("products")
    .select("type_code,marketplace_categories,marketplace_attributes")
    .eq("id", productId).single().throwOnError();
  const typeResult = await db.from("config_types").select("marketplace_category")
    .eq("code", productResult.data.type_code).maybeSingle().throwOnError();
  const internalCategory = String(typeResult.data?.marketplace_category || "").trim();
  const categories = structuredClone((productResult.data.marketplace_categories || {}) as Record<string, any>);
  const attributes = structuredClone((productResult.data.marketplace_attributes || {}) as MarketplaceValues);
  const hasCategorySnapshot = Object.keys(categories).length > 0;
  const categoryId = String(rawData.category_id || "").trim();
  if (categoryId) {
    const categoryName = await getMarketplaceCategoryPath(marketplace, categoryId).catch(() => "");
    categories[marketplace] = { categoryId, categoryName, source: "marketplace", attributes: {} };
    if (productResult.data.type_code !== "OT" && internalCategory) categories.internal_category = internalCategory;
    const group = attributes[marketplace] ||= { categoryId, attributes: {} };
    group.categoryId = categoryId;
    Object.assign(group.attributes, extractListingAttributeValues(marketplace, rawData));
  } else if (!hasCategorySnapshot && internalCategory) {
    const mapping = await db.from("marketplace_category_mappings").select("*")
      .eq("internal_category", internalCategory).maybeSingle().throwOnError();
    categories.internal_category = internalCategory;
    const fallbackId = String(mapping.data?.[`${marketplace}_code`] || "");
    if (fallbackId) categories[marketplace] = { categoryId: fallbackId, attributes: {} };
  }
  await db.rpc("sync_product_marketplace_metadata", {
    p_product_id: productId,
    p_categories: categories,
    p_attributes: attributes
  }).throwOnError();
}

export async function ensureProductMarketplaceCategoryFallbacks(productId: string) {
  const db = supabaseAdmin();
  const product = await db.from("products").select("type_code,marketplace_categories,marketplace_attributes")
    .eq("id", productId).single().throwOnError();
  const type = await db.from("config_types").select("marketplace_category").eq("code", product.data.type_code).maybeSingle().throwOnError();
  const internalCategory = String(type.data?.marketplace_category || "").trim();
  const mapping = internalCategory ? await db.from("marketplace_category_mappings").select("*")
    .eq("internal_category", internalCategory).maybeSingle().throwOnError() : { data: null };
  const [marketplaceLinks, listingLinks] = await Promise.all([
    db.from("product_marketplaces").select("marketplace").eq("product_id", productId)
      .eq("existe_no_marketplace", true).not("marketplace_product_id", "is", null).throwOnError(),
    db.from("listings").select("marketplace").eq("product_id", productId).not("external_listing_id", "is", null).throwOnError()
  ]);
  const linked = new Set([...marketplaceLinks.data, ...listingLinks.data].map(row => String(row.marketplace)));
  const categories = structuredClone((product.data.marketplace_categories || {}) as Record<string, any>);
  const attributes = structuredClone((product.data.marketplace_attributes || {}) as MarketplaceValues);
  if (product.data.type_code !== "OT") categories.internal_category = internalCategory;
  for (const marketplace of ["mercado_livre", "shopee"] as MarketplaceCode[]) {
    if (linked.has(marketplace) || categories[marketplace]?.categoryId) continue;
    const categoryId = String(mapping.data?.[`${marketplace}_code`] || "");
    if (!categoryId) continue;
    const categoryName = String(mapping.data?.[`${marketplace}_description`] || "");
    categories[marketplace] = { categoryId, categoryName, source: "type", attributes: {} };
    attributes[marketplace] ||= { categoryId, attributes: {} };
  }
  await db.rpc("sync_product_marketplace_metadata", { p_product_id: productId, p_categories: categories, p_attributes: attributes }).throwOnError();
}

function extractListingAttributeValues(marketplace: MarketplaceCode, rawData: Record<string, unknown>) {
  const values: Record<string, AttributeValue> = {};
  if (marketplace === "mercado_livre") {
    for (const item of Array.isArray(rawData.attributes) ? rawData.attributes as Array<Record<string, any>> : []) {
      const id = String(item.id || "");
      if (!id) continue;
      const valueId = String(item.value_id || item.values?.[0]?.id || "").trim();
      const valueName = String(item.value_name || item.values?.[0]?.name || "").trim();
      if (valueId || valueName) values[id] = { ...(valueId ? { valueId } : {}), ...(valueName ? { valueName } : {}) };
    }
  } else {
    for (const item of Array.isArray(rawData.attribute_list) ? rawData.attribute_list as Array<Record<string, any>> : []) {
      const id = String(item.attribute_id || "");
      const entries = Array.isArray(item.attribute_value_list) ? item.attribute_value_list as Array<Record<string, any>> : [];
      if (!id || !entries.length) continue;
      const valueId = String(entries[0].value_id || "").trim();
      const valueName = String(entries[0].original_value_name || entries[0].value_name || "").trim();
      values[id] = { ...(valueId ? { valueId } : {}), ...(valueName ? { valueName } : {}) };
    }
  }
  return values;
}

export async function buildProductMarketplaceSnapshot(typeCode: string, product?: Record<string, any>): Promise<{ categories: MarketplaceValues; attributes: MarketplaceValues }> {
  const db = supabaseAdmin();
  const type = await db.from("config_types").select("marketplace_category,marketplace_attribute_defaults,warranty_months").eq("code", typeCode).single().throwOnError();
  const special = product?.special_code
    ? await db.from("config_specials").select("keep_warranty").eq("code", product.special_code).maybeSingle().throwOnError()
    : { data: null };
  const warrantyMonths = special.data?.keep_warranty === false ? 0 : type.data.warranty_months;
  if (!type.data.marketplace_category) return { categories: {}, attributes: {} };
  const mapping = await db.from("marketplace_category_mappings").select("*").eq("internal_category", type.data.marketplace_category).maybeSingle().throwOnError();
  if (!mapping.data) return { categories: {}, attributes: {} };
  const defaults = (type.data.marketplace_attribute_defaults || {}) as MarketplaceValues;
  const definitions = (mapping.data.attribute_definitions || {}) as MarketplaceDefinitions;
  const categories: MarketplaceValues = {};
  const attributes: MarketplaceValues = {};
  (categories as any).internal_category = String(type.data.marketplace_category);
  for (const marketplace of ["mercado_livre", "shopee"] as MarketplaceCode[]) {
    const definition = definitions[marketplace];
    const categoryId = String(definition?.categoryId || mapping.data[`${marketplace}_code`] || "");
    if (!categoryId) continue;
    categories[marketplace] = { categoryId, attributes: {} };
    attributes[marketplace] = { categoryId, attributes: resolveInitialValues(marketplace, definition?.attributes || {}, defaults[marketplace]?.attributes || {}, warrantyMonths, product, special.data?.keep_warranty === false) };
  }
  return { categories, attributes };
}

function resolveInitialValues(marketplace: MarketplaceCode, definitions: Record<string, AttributeDefinition>, defaults: Record<string, AttributeValue>, warrantyMonths: number, product?: Record<string, any>, forceNoWarranty = false) {
  const values: Record<string, AttributeValue> = structuredClone(defaults || {});
  for (const definition of Object.values(definitions)) {
    const automatic = automaticValue(definition.systemSource, product);
    if (automatic) values[definition.id] = automatic;
  }
  if (marketplace === "shopee") {
    const durationIds: Record<number, string> = { 1: "776", 2: "789", 3: "799", 6: "810", 12: "822", 24: "831", 36: "857", 60: "843" };
    const hasWarranty = Number(warrantyMonths || 0) > 0 && Boolean(durationIds[Number(warrantyMonths)]);
    const warrantyType = { valueId: hasWarranty ? "2437" : "5576", valueName: hasWarranty ? "Supplier Warranty" : "No Warranty" };
    const warrantyTime = { valueId: hasWarranty ? durationIds[Number(warrantyMonths)] : "5577", valueName: hasWarranty ? `${warrantyMonths} Months` : "No Warranty" };
    if (forceNoWarranty) {
      values["100370"] = warrantyType;
      values["100121"] = warrantyTime;
    } else {
      values["100370"] ||= warrantyType;
      values["100121"] ||= warrantyTime;
    }
  }
  if (marketplace === "mercado_livre") {
    const months = Number(warrantyMonths || 0);
    if (forceNoWarranty) {
      values.WARRANTY_TYPE = { valueId: "6150835", valueName: "Sem garantia" };
      delete values.WARRANTY_TIME;
    } else {
      values.WARRANTY_TYPE ||= months > 0 ? { valueId: "2230280", valueName: "Garantia do vendedor" } : {};
      values.WARRANTY_TIME ||= months > 0 ? { valueName: `${months} meses` } : {};
    }
  }
  return values;
}

function automaticValue(source?: string, product?: Record<string, any>): AttributeValue | undefined {
  if (!source || !product) return undefined;
  const map: Record<string, unknown> = { brand: product.brand_name, model: product.model, board_code: product.board_code, sku: product.sku,
    title: product.title, description: product.description, product_condition: product.product_condition, height: product.height,
    width: product.width, length: product.length, weight_gross: product.weight_gross };
  const value = map[source]; return value === null || value === undefined || value === "" ? undefined : { valueName: String(value) };
}

export function validateRequiredAttributes(definitions: MarketplaceDefinitions, values: MarketplaceValues) {
  const missing: Array<{ marketplace: MarketplaceCode; name: string }> = [];
  for (const marketplace of ["mercado_livre", "shopee"] as MarketplaceCode[]) {
    for (const definition of Object.values(definitions[marketplace]?.attributes || {})) {
      if (!definition.required || definition.systemSource) continue;
      const value = values[marketplace]?.attributes?.[definition.id];
      if (!value || (!value.valueId && !value.valueName && !value.valueIds?.length && !value.valueNames?.length)) missing.push({ marketplace, name: definition.name });
    }
  }
  return missing;
}

function mlInputType(type: string, tags: Record<string, unknown> = {}) : AttributeDefinition["inputType"] {
  if (tags.multivalued) return type === "list" ? "multi_select" : "multi_combo";
  if (type === "list" || type === "boolean") return "select";
  if (["number", "number_unit"].includes(type)) return "number";
  if (type === "date") return "date";
  return "text";
}
function shopeeInputType(type: number, id: string): AttributeDefinition["inputType"] {
  if (id === "101219") return "boolean";
  return ({ 1: "select", 2: "combo", 3: "text", 4: "multi_select", 5: "multi_combo" } as const)[type as 1] || "text";
}
