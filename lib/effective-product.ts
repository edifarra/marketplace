import type { MarketplaceCode, MarketplaceDefinitions, MarketplaceValues } from "./marketplace-attributes";

type Row = Record<string, any>;

export type EffectiveMarketplace = {
  categoryId: string;
  categoryName: string;
  categorySource: "listing" | "type" | "product" | "none";
  categoryMatchesType: boolean;
  hasActiveListing: boolean;
  attributes: Record<string, any>;
  payloadAttributes: Record<string, any>;
  visibleAttributeIds: string[];
};

export type EffectiveProduct = Row & {
  sku: string;
  title: string;
  description?: string | null;
  model?: string | null;
  version?: string | null;
  board_code?: string | null;
  width: number;
  height: number;
  length: number;
  weight_net: number;
  weight_gross: number;
  brand_name: string;
  estoque_fisico: number;
  estoque_disponivel: number;
  marketplace_categories: Row;
  marketplace_attributes: MarketplaceValues;
  marketplace_active_attributes: Partial<Record<MarketplaceCode, string[]>> | null;
  effective_marketplaces: Record<MarketplaceCode, EffectiveMarketplace>;
};

/**
 * Resolves the single product representation consumed by the UI and publishers.
 * It is deliberately pure so payload regressions can be tested without a database.
 */
export function resolveEffectiveProduct(input: {
  product: Row;
  type?: Row | null;
  brand?: Row | null;
  special?: Row | null;
  inventory?: Row | null;
  mapping?: Row | null;
  marketplaceLinks?: Row[];
  listingDefinitions?: MarketplaceDefinitions;
}): EffectiveProduct {
  const { product, type, brand, inventory, mapping } = input;
  const storedCategories = structuredClone((product.marketplace_categories || {}) as Row);
  const storedValues = structuredClone((product.marketplace_attributes || {}) as MarketplaceValues);
  const defaults = (type?.marketplace_attribute_defaults || {}) as MarketplaceValues;
  const configured = (type?.marketplace_active_attributes || null) as Partial<Record<MarketplaceCode, string[]>> | null;
  const definitions = (mapping?.attribute_definitions || {}) as MarketplaceDefinitions;
  const internalCategory = product.type_code === "OT"
    ? String(storedCategories.internal_category || type?.marketplace_category || "")
    : String(type?.marketplace_category || storedCategories.internal_category || "");
  const categories: Row = { ...storedCategories, internal_category: internalCategory };
  const values: MarketplaceValues = {};
  const effectiveMarketplaces = {} as Record<MarketplaceCode, EffectiveMarketplace>;

  for (const marketplace of ["mercado_livre", "shopee"] as const) {
    const links = (input.marketplaceLinks || []).filter(link => String(link.marketplace) === marketplace);
    const active = links.find(link => ["active", "normal"].includes(String(link.status_anuncio || link.status || "").toLowerCase()));
    const rawCategoryId = String(active?.raw_data?.category_id || active?.raw_data?.category?.category_id || "").trim();
    const typeCategoryId = String(mapping?.[`${marketplace}_code`] || "").trim();
    const storedCategoryId = String(storedCategories[marketplace]?.categoryId || "").trim();
    const categoryId = rawCategoryId || (active ? storedCategoryId : typeCategoryId || storedCategoryId);
    const categoryMatchesType = Boolean(categoryId && typeCategoryId && categoryId === typeCategoryId);
    const categoryName = String(
      active?.effective_category_name
      ||
      (rawCategoryId && storedCategoryId === rawCategoryId ? storedCategories[marketplace]?.categoryName : "")
      || (!active && categoryId === typeCategoryId ? mapping?.[`${marketplace}_description`] : "")
      || storedCategories[marketplace]?.categoryName
      || (categoryId === typeCategoryId ? mapping?.[`${marketplace}_description`] : "")
      || ""
    );
    const categorySource: EffectiveMarketplace["categorySource"] = rawCategoryId
      ? "listing"
      : active && storedCategoryId ? "listing"
      : typeCategoryId && categoryId === typeCategoryId ? "type"
      : storedCategoryId ? "product" : "none";
    const mergedAttributes = mergeAttributeGroups(defaults[marketplace]?.attributes, storedValues[marketplace]?.attributes);
    if (product.special_code && input.special?.keep_warranty === false) applyNoWarranty(marketplace, mergedAttributes);
    values[marketplace] = { categoryId, attributes: mergedAttributes };
    categories[marketplace] = { categoryId, categoryName, source: categorySource, attributes: {} };

    const categoryDefinitions = (active && !categoryMatchesType
      ? input.listingDefinitions?.[marketplace]?.attributes
      : definitions[marketplace]?.attributes) || {};
    const requiredIds = Object.values(categoryDefinitions).filter(attribute => attribute.required && !attribute.systemSource).map(attribute => attribute.id);
    const configuredIds = configured?.[marketplace];
    const additionalIds = !active || categoryMatchesType
      ? (configuredIds === undefined ? Object.keys(categoryDefinitions) : configuredIds).filter(id => !categoryDefinitions[id]?.systemSource)
      : [];
    effectiveMarketplaces[marketplace] = {
      categoryId, categoryName, categorySource, categoryMatchesType, hasActiveListing: Boolean(active),
      attributes: mergedAttributes,
      payloadAttributes: active && !categoryMatchesType && !input.listingDefinitions?.[marketplace]
        ? mergedAttributes
        : pickAttributes(mergedAttributes, [...requiredIds, ...additionalIds,
          ...(marketplace === "mercado_livre" ? ["WARRANTY_TYPE", "WARRANTY_TIME"] : ["100370", "100121"])]),
      visibleAttributeIds: [...new Set([...requiredIds, ...additionalIds])]
    };
  }

  return {
    ...product,
    sku: String(product.sku || ""),
    title: String(product.title || ""),
    brand_name: String(brand?.name || ""),
    width: effectiveNumber(product.width, type?.width),
    height: effectiveNumber(product.height, type?.height),
    length: effectiveNumber(product.length, type?.length),
    weight_net: effectiveNumber(product.weight_net, type?.weight_net),
    weight_gross: effectiveNumber(product.weight_gross, type?.weight_gross),
    estoque_fisico: Number(inventory?.estoque_fisico ?? product.stock ?? 0),
    estoque_disponivel: Number(inventory?.estoque_disponivel ?? product.stock ?? 0),
    marketplace_categories: categories,
    marketplace_attributes: values,
    marketplace_active_attributes: Object.fromEntries(
      (["mercado_livre", "shopee"] as const).map(marketplace => [marketplace, effectiveMarketplaces[marketplace].visibleAttributeIds])
    ),
    effective_marketplaces: effectiveMarketplaces
  };
}

function applyNoWarranty(marketplace: MarketplaceCode, attributes: Record<string, any>) {
  if (marketplace === "shopee") {
    attributes["100370"] = { valueId: "5576", valueName: "No Warranty" };
    attributes["100121"] = { valueId: "5577", valueName: "No Warranty" };
    return;
  }
  attributes.WARRANTY_TYPE = { valueId: "6150835", valueName: "Sem garantia" };
  delete attributes.WARRANTY_TIME;
}

function effectiveNumber(value: unknown, fallback: unknown) {
  const selected = value == null || value === "" ? fallback : value;
  return Number(selected ?? 0);
}

function mergeAttributeGroups(defaults?: Record<string, any>, stored?: Record<string, any>) {
  const result = structuredClone(defaults || {});
  for (const [id, value] of Object.entries(stored || {})) result[id] = { ...(result[id] || {}), ...(value as Row) };
  return result;
}

function pickAttributes(values: Record<string, any>, ids: string[]) {
  return Object.fromEntries([...new Set(ids)].filter(id => values[id] != null).map(id => [id, values[id]]));
}

export function mercadoLivrePackageAttributes(product: Pick<EffectiveProduct, "height" | "width" | "length" | "weight_gross">) {
  const height = positiveIntegerCentimeters(product.height, "altura");
  const width = positiveIntegerCentimeters(product.width, "largura");
  const length = positiveIntegerCentimeters(product.length, "comprimento");
  const weight = Math.ceil(Number(product.weight_gross) * 1000);
  if (!Number.isFinite(weight) || weight <= 0) throw new Error("Peso bruto do pacote deve ser maior que zero.");
  return [
    { id: "SELLER_PACKAGE_HEIGHT", value_name: `${height} cm` },
    { id: "SELLER_PACKAGE_WIDTH", value_name: `${width} cm` },
    { id: "SELLER_PACKAGE_LENGTH", value_name: `${length} cm` },
    { id: "SELLER_PACKAGE_WEIGHT", value_name: `${weight} g` }
  ];
}

function positiveIntegerCentimeters(value: unknown, label: string) {
  const result = Math.ceil(Number(value));
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} do pacote deve ser maior que zero.`);
  return result;
}
