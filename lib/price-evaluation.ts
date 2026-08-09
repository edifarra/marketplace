import { parsePhotoName } from "./pipeline";
import { supabaseAdmin } from "./supabase-admin";
import { getActiveMercadoLivreAccounts, getValidMercadoLivreAccessToken } from "./mercado-livre";

export type PriceEvaluationProduct = {
  id?: string; sku: string; source_key: string; title?: string | null; type_code: string; brand_code: string;
  model: string | null; version: string | null; board_code: string | null;
};

type SearchItem = { id?: string; title?: string; price?: number; permalink?: string; searchText?: string };

export type EvaluatedListing = {
  id: string; title: string; link: string; price: number; inRange: boolean;
  considered: boolean; valid: boolean; deniedWords: string[];
  searchTermsFound: boolean; rejectionReasons: string[];
  boardCodeFound: boolean | null; versionFound: boolean | null;
};

export type PriceEvaluation = {
  product: PriceEvaluationProduct;
  typeName: string;
  brandName: string;
  searchString: string;
  searchUrl: string;
  catalogUrl: string;
  searchSource: "CACHE" | "CATALOGO";
  searchedAt: string;
  cacheExpiresAt: string;
  settings: Record<string, unknown>;
  listings: EvaluatedListing[];
  average: number | null;
  lowest: number | null;
  secondLowest: number | null;
  highest: number | null;
  suggested: number | null;
  effectiveDeflator: number;
  appliedRange: DeflatorRange | null;
  basedOnMinimum: boolean;
  status: "CALCULADO" | "VERIFICACAO_MANUAL" | "PRECO_MINIMO";
  error?: string;
};

export type DeflatorRange = {
  min: number; max: number; value: number; arred: boolean; deflator: "valor" | "porcentagem";
};

const PRICE_KEYS = [
  "QUANTIDADE_ANUNCIOS_RECUPERADOS", "QUANTIDADE_ANUNCIOS_PARA_CALCULO", "DEFINICAO_PRECO",
  "TIPO_DEFLATOR", "VALOR_DEPLATOR", "VALOR_MINIMO", "VALOR_MÍNIMO",
  "PERCENTUAL_OUTLIER_INFERIOR", "VALORES_EM_GAP", "PALAVRAS_NEGADAS",
  "FAIXA_DEFLATOR_1", "FAIXA_DEFLATOR_2", "FAIXA_DEFLATOR_3", "FAIXA_DEFLATOR_4", "FAIXA_DEFLATOR_5"
];

const DEFAULT_DENIED_WORDS = ["defeito", "com defeito", "não funciona", "nao funciona", "sucata", "para conserto", "quebrado"];

export async function evaluatePrice(rawQuery: string, options: { forceOnline?: boolean } = {}): Promise<PriceEvaluation | null> {
  const query = rawQuery.trim();
  if (!query) return null;
  const supabase = supabaseAdmin();
  let product: PriceEvaluationProduct | null = null;

  const bySku = await supabase.from("products").select("id,sku,source_key,title,type_code,brand_code,model,version,board_code").ilike("sku", query).maybeSingle();
  if (bySku.error) throw new Error(bySku.error.message);
  product = bySku.data as PriceEvaluationProduct | null;

  if (!product) {
    const sourceKey = sourceKeyFromInput(query);
    const bySource = await supabase.from("products").select("id,sku,source_key,title,type_code,brand_code,model,version,board_code").ilike("source_key", sourceKey).maybeSingle();
    if (bySource.error) throw new Error(bySource.error.message);
    product = bySource.data as PriceEvaluationProduct | null;
  }
  if (!product) throw new Error("Nenhum produto encontrado para o SKU ou string da foto informada.");

  return evaluatePriceForProduct(product, options);
}

export async function evaluatePriceForProduct(product: PriceEvaluationProduct, options: { forceOnline?: boolean } = {}): Promise<PriceEvaluation> {
  const supabase = supabaseAdmin();

  const [typeResult, brandResult, settingsResult] = await Promise.all([
    supabase.from("config_types").select("description,search_term,marketplace_category").eq("code", product.type_code).maybeSingle(),
    supabase.from("config_brands").select("name").eq("code", product.brand_code).maybeSingle(),
    supabase.from("settings").select("key,value").in("key", PRICE_KEYS)
  ]);
  const categoryResult = typeResult.data?.marketplace_category
    ? await supabase.from("marketplace_category_mappings").select("mercado_livre_description")
      .eq("internal_category", typeResult.data.marketplace_category).maybeSingle()
    : { data: null };
  const settings = Object.fromEntries((settingsResult.data || []).map((row) => [row.key, row.value]));
  const configuredTerm = applySearchTerm(String(typeResult.data?.search_term || typeResult.data?.description || ""), String(brandResult.data?.name || product.brand_code));
  const identifiedSearchString = [configuredTerm, product.model, product.version, product.board_code]
    .map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  const searchString = identifiedSearchString || String(product.title || "").trim();
  if (!searchString) {
    throw new Error("O produto foi localizado, mas não possui dados de identificação nem título para montar a busca no Mercado Livre.");
  }
  const categoryDescription = categoryResult.data?.mercado_livre_description || "";
  const searchUrl = mercadoLivreSearchUrl(searchString, 1, categoryDescription);
  const catalogUrl = mercadoLivreCatalogUrl(searchString);
  const recoveredLimit = boundedNumber(settings.QUANTIDADE_ANUNCIOS_RECUPERADOS, 50, 1, 100);
  const calculationLimit = boundedNumber(settings.QUANTIDADE_ANUNCIOS_PARA_CALCULO, 5, 1, recoveredLimit);
  const minimumValidListings = boundedNumber(settings.VALORES_EM_GAP, 3, 1, recoveredLimit);
  const deniedWords = parseWords(settings.PALAVRAS_NEGADAS);
  const requiredTerms = searchTerms(searchString);
  const normalizedModel = alphanumeric(product.model || "");

  let items: SearchItem[] = [];
  let searchError = "";
  let searchSource: PriceEvaluation["searchSource"] = "CATALOGO";
  let searchedAt = new Date().toISOString();
  if (!options.forceOnline && product.id) {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const cached = await supabase.from("price_search_cache").select("listings,searched_at")
      .eq("product_id", product.id).gte("searched_at", cutoff).order("searched_at", { ascending: false }).limit(1).maybeSingle();
    if (!cached.error && cached.data) {
      items = Array.isArray(cached.data.listings) ? cached.data.listings as SearchItem[] : [];
      searchedAt = String(cached.data.searched_at);
      searchSource = "CACHE";
    }
  }
  if (searchSource !== "CACHE") {
    try {
      items = await searchCatalogListingsPaginated(searchString, product, typeResult.data?.description || "", recoveredLimit);
      searchedAt = new Date().toISOString();
      if (product.id) await supabase.from("price_search_cache").insert({ product_id: product.id, sku: product.sku, search_string: searchString, listings: items, searched_at: searchedAt }).throwOnError();
    } catch (cause) {
      searchError = `Falha na consulta online pela API oficial do Mercado Livre: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  const initial = items.map((item, index) => {
    const title = String(item.title || "Anúncio sem título");
    const normalizedTitle = alphanumeric(title);
    const normalized = alphanumeric(String(item.searchText || title));
    const matched = deniedWords.filter((word) => normalized.includes(alphanumeric(word)));
    const termsFound = requiredTerms.every((term) => {
      if (term === normalizedModel && term.length > 2) {
        return normalizedTitle.includes(term) || normalizedTitle.includes(term.slice(0, -2));
      }
      return normalizedTitle.includes(term);
    });
    return {
      id: String(item.id || index), title, link: String(item.permalink || ""), price: Number(item.price || 0), deniedWords: matched,
      searchTermsFound: termsFound,
      boardCodeFound: product.board_code ? normalized.includes(alphanumeric(product.board_code)) : null,
      versionFound: product.version ? normalized.includes(alphanumeric(product.version)) : null
    };
  });
  const ordered = initial.sort((a, b) => a.price - b.price);
  const eligibleBeforeOutlier = ordered.filter((item) => item.price > 0 && item.searchTermsFound && item.deniedWords.length === 0);
  const outlierPercent = normalizePercent(settings.PERCENTUAL_OUTLIER_INFERIOR, .4);
  const firstIsOutlier = eligibleBeforeOutlier.length > 1
    && eligibleBeforeOutlier[1].price > eligibleBeforeOutlier[0].price * (1 + outlierPercent);
  const outlierId = firstIsOutlier ? eligibleBeforeOutlier[0].id : null;
  const eligible = eligibleBeforeOutlier.filter((item) => item.id !== outlierId);
  const manualVerification = eligible.length < minimumValidListings;
  const calculationIds = new Set(manualVerification ? [] : eligible.slice(0, calculationLimit).map((item) => item.id));
  const listings = ordered.map((item): EvaluatedListing => {
    const rejectionReasons: string[] = [];
    if (item.price <= 0) rejectionReasons.push("Preço inválido");
    if (!item.searchTermsFound) rejectionReasons.push("Não contém todos os termos da busca");
    if (item.deniedWords.length) rejectionReasons.push("Contém palavra negada");
    if (item.id === outlierId) rejectionReasons.push("Primeiro preço descartado pelo percentual de outlier inferior");
    const valid = rejectionReasons.length === 0;
    return { ...item, inRange: item.id !== outlierId, valid, considered: valid && calculationIds.has(item.id), rejectionReasons };
  });
  const validPrices = listings.filter((item) => item.considered).map((item) => item.price).sort((a, b) => a - b);
  const average = validPrices.length ? validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length : null;
  const lowest = manualVerification ? (eligible[0]?.price ?? null) : (validPrices.at(0) ?? null);
  const secondLowest = manualVerification ? null : (validPrices.at(1) ?? null);
  const highest = manualVerification ? null : (validPrices.at(-1) ?? null);
  const definition = String(settings.DEFINICAO_PRECO || "MENOR").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let base = definition === "MAIOR" ? highest : definition === "MEDIA" ? average : definition === "SEGUNDO" ? (validPrices[1] ?? lowest) : lowest;
  if (manualVerification) base = eligible[0]?.price ?? null;
  if (base !== null) base = Math.trunc(base);
  const appliedRange = base === null || manualVerification ? null : resolveDeflatorRange(base, settings);
  const effectiveDeflator = appliedRange?.value ?? 0;
  if (base !== null && appliedRange) {
    if (appliedRange.arred) base = roundPriceDown(base);
    base = appliedRange.deflator === "porcentagem" ? Math.trunc(base * (1 - appliedRange.value / 100)) : base - appliedRange.value;
  }
  const minimum = Number(settings.VALOR_MINIMO ?? settings["VALOR_MÍNIMO"] ?? 20);
  const basedOnMinimum = base === null || base < minimum;
  const suggested = base === null ? minimum : Math.max(minimum, Math.round(base * 100) / 100);
  const status = manualVerification ? "VERIFICACAO_MANUAL" : base === null ? "PRECO_MINIMO" : "CALCULADO";

  return {
    product, typeName: String(typeResult.data?.description || product.type_code || "Não identificado"), brandName: String(brandResult.data?.name || product.brand_code || "Não identificada"),
    searchString, searchUrl, catalogUrl, searchSource, searchedAt, cacheExpiresAt: new Date(new Date(searchedAt).getTime() + 72 * 60 * 60 * 1000).toISOString(), settings, listings, average, lowest, secondLowest, highest, suggested, effectiveDeflator, appliedRange, basedOnMinimum, status,
    error: searchError || undefined
  };
}

async function searchCurrentCatalogListings(searchString: string, product: PriceEvaluationProduct, typeName: string, limit: number): Promise<SearchItem[]> {
  const accounts = await getActiveMercadoLivreAccounts();
  if (!accounts.length) throw new Error("Nenhuma conta Mercado Livre conectada para acessar o catálogo oficial.");
  const accessToken = await getValidMercadoLivreAccessToken(accounts[0]);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const response = await fetch(`https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(searchString)}&limit=100`, { headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Busca atual do catálogo Mercado Livre respondeu HTTP ${response.status}.`);
  const payload = await response.json();
  const products = (Array.isArray(payload.results) ? payload.results : []) as Array<{ id?: string; name?: string }>;
  const identifiers = [product.model, product.board_code, product.version].map((value) => normalize(String(value || ""))).filter((value) => value.length >= 4);
  const typeTerms = normalize(typeName).split(/\s+/).filter((term) => term.length >= 5 && !["pecas", "produto"].includes(term));
  const matching = products.filter((catalogProduct) => {
    const name = normalize(String(catalogProduct.name || ""));
    const identifierMatch = identifiers.length === 0 || identifiers.some((identifier) => name.includes(identifier));
    const typeMatch = typeTerms.length === 0 || typeTerms.some((term) => name.includes(term));
    return Boolean(catalogProduct.id && identifierMatch && typeMatch);
  }).slice(0, 15);

  const pages = await Promise.all(matching.map(async (catalogProduct) => {
    const itemResponse = await fetch(`https://api.mercadolibre.com/products/${encodeURIComponent(String(catalogProduct.id))}/items`, { headers, cache: "no-store" });
    if (!itemResponse.ok) return [];
    const itemPayload = await itemResponse.json();
    return (Array.isArray(itemPayload.results) ? itemPayload.results : []).map((item: { item_id?: string; price?: number }) => ({
      id: String(item.item_id || ""),
      title: String(catalogProduct.name || "Anúncio sem título"),
      price: Number(item.price || 0),
      permalink: mercadoLivreItemLink(String(item.item_id || ""))
    }));
  }));
  const unique = new Map<string, SearchItem>();
  for (const item of pages.flat()) if (item.id && !unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()].slice(0, limit);
}

async function searchCatalogListingsPaginated(searchString: string, product: PriceEvaluationProduct, typeName: string, limit: number): Promise<SearchItem[]> {
  const accounts = await getActiveMercadoLivreAccounts();
  if (!accounts.length) throw new Error("Nenhuma conta Mercado Livre conectada para acessar o catálogo oficial.");
  const accessToken = await getValidMercadoLivreAccessToken(accounts[0]);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const identifiers = [product.model, product.board_code, product.version].map((value) => normalize(String(value || ""))).filter((value) => value.length >= 4);
  const typeTerms = normalize(typeName).split(/\s+/).filter((term) => term.length >= 5 && !["pecas", "produto"].includes(term));
  const unique = new Map<string, SearchItem>();
  const visitedProducts = new Set<string>();

  for (let offset = 0; offset < 500 && unique.size < limit; offset += 100) {
    const response = await fetch(`https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(searchString)}&limit=100&offset=${offset}`, { headers, cache: "no-store" });
    if (!response.ok) throw new Error(`Busca atual do catálogo Mercado Livre respondeu HTTP ${response.status}.`);
    const payload = await response.json();
    const products = (Array.isArray(payload.results) ? payload.results : []) as CatalogProduct[];
    const matching = products.filter((catalogProduct) => {
      const id = String(catalogProduct.id || "");
      const name = normalize(String(catalogProduct.name || ""));
      const identifierMatch = identifiers.length === 0 || identifiers.some((identifier) => name.includes(identifier));
      const typeMatch = typeTerms.length === 0 || typeTerms.some((term) => name.includes(term));
      return Boolean(id && !visitedProducts.has(id) && identifierMatch && typeMatch);
    });
    for (const catalogProduct of matching) visitedProducts.add(String(catalogProduct.id));
    const pages = await Promise.all(matching.map(async (catalogProduct) => {
      const itemResponse = await fetch(`https://api.mercadolibre.com/products/${encodeURIComponent(String(catalogProduct.id))}/items`, { headers, cache: "no-store" });
      if (!itemResponse.ok) return [];
      const itemPayload = await itemResponse.json();
      return (Array.isArray(itemPayload.results) ? itemPayload.results : []).map((item: { item_id?: string; price?: number }) => ({
        id: String(item.item_id || ""), title: String(catalogProduct.name || "Anúncio sem título"), price: Number(item.price || 0),
        permalink: mercadoLivreItemLink(String(item.item_id || "")), searchText: catalogSearchText(catalogProduct)
      }));
    }));
    for (const item of pages.flat()) if (item.id && !unique.has(item.id)) unique.set(item.id, item);
    if (products.length < 100) break;
  }
  return [...unique.values()].sort((a, b) => Number(a.price || 0) - Number(b.price || 0)).slice(0, limit);
}

function mercadoLivreItemLink(itemId: string) {
  const number = itemId.replace(/^MLB/i, "");
  return number ? `https://produto.mercadolivre.com.br/MLB-${number}-_JM` : "";
}

function mercadoLivreCatalogUrl(searchString: string) {
  return `https://api.mercadolibre.com/products/search?status=active&site_id=MLB&q=${encodeURIComponent(searchString)}&limit=100&offset=0`;
}

function mercadoLivreSearchUrl(searchString: string, _offset?: number, _categoryDescription?: string) {
  return `https://lista.mercadolivre.com.br/${encodeURIComponent(searchString)}`;
}

type CatalogProduct = {
  id?: string;
  name?: string;
  short_description?: { content?: string } | string;
  attributes?: Array<{ name?: string; value_name?: string; values?: Array<{ name?: string }> }>;
};

function catalogSearchText(product: CatalogProduct) {
  const description = typeof product.short_description === "string" ? product.short_description : product.short_description?.content;
  const attributes = (product.attributes || []).flatMap((attribute) => [attribute.name, attribute.value_name, ...(attribute.values || []).map((value) => value.name)]);
  return [product.name, description, ...attributes].filter(Boolean).join(" ");
}

function applySearchTerm(template: string, brand: string) {
  return template.replace(/<MARCA>|\[MARCA\]/gi, brand).replace(/\s+/g, " ").trim();
}

function resolveDeflatorRange(price: number, settings: Record<string, unknown>) {
  for (let index = 1; index <= 5; index += 1) {
    const range = parseDeflatorRange(settings[`FAIXA_DEFLATOR_${index}`]);
    if (range && price >= range.min && price <= range.max) return range;
  }
  return null;
}

function parseDeflatorRange(value: unknown) {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  if (row.enabled === false) return null;
  const min = Number(row.min ?? row.de);
  const max = Number(row.max ?? row.ate);
  const rangeValue = Number(row.value ?? row.valor);
  const deflator = normalize(String(row.deflator || "valor")) === "porcentagem" ? "porcentagem" : "valor";
  return [min, max, rangeValue].every(Number.isFinite) ? { min, max, value: rangeValue, arred: row.arred === true, deflator } as DeflatorRange : null;
}

function roundPriceDown(value: number) {
  return Math.floor(value / 5) * 5;
}

function sourceKeyFromInput(value: string) {
  try { return parsePhotoName(value).sourceKey; } catch { return value.replace(/\.(jpg|jpeg|png|webp|heic|heif)$/i, "").replace(/_0?[1-6]$/i, ""); }
}
function boundedNumber(value: unknown, fallback: number, min: number, max: number) { return Math.min(max, Math.max(min, Math.round(Number(value) || fallback))); }
function normalizePercent(value: unknown, fallback: number) {
  const raw = String(value ?? "").trim();
  const number = Number(raw.replace("%", "").replace(",", "."));
  return Number.isFinite(number) ? (raw.includes("%") || number > 1 ? number / 100 : number) : fallback;
}
function normalize(value: string) { return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function alphanumeric(value: string) { return normalize(value).replace(/[^a-z0-9]/g, ""); }
function searchTerms(value: string) { return value.split(/\s+/).map(alphanumeric).filter(Boolean); }
function parseWords(value: unknown) {
  const words = String(value || "").split(/[;,\n|]/).map((word) => word.trim()).filter(Boolean);
  return words.length ? words : DEFAULT_DENIED_WORDS;
}
