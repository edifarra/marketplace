import {
  getActiveMercadoLivreAccounts,
  isMercadoLivreInactive,
  listMercadoLivreInventory,
  removeMercadoLivreListing,
  updateMercadoLivreStock
} from "./mercado-livre";
import { supabaseAdmin } from "./supabase-admin";

export type MigrationStockView = "marketplace-only" | "system-only" | "missing-marketplace" | "stock-divergent";

type SystemProduct = {
  id: string;
  sku: string;
  title: string;
  description: string;
  price: number;
  stock: number;
  status: string;
};

type MarketplaceAccount = {
  id: string;
  name: string;
  marketplace: string;
};

export type MarketplaceLink = {
  id: string;
  product_id?: string | null;
  sku: string;
  marketplace_account_id: string;
  marketplace: string;
  marketplace_product_id: string;
  titulo_marketplace: string;
  valor_marketplace: number;
  estoque_marketplace: number;
  status_anuncio: string;
  existe_no_marketplace: boolean;
};

export type MigrationStockRow = {
  sku: string;
  title: string;
  price: number;
  systemStock?: number;
  productId?: string;
  marketplaces: MarketplaceLink[];
};

export type MigrationStockSummary = {
  marketplaceOnly: number;
  systemOnly: number;
  missingMarketplace: number;
  stockDivergent: number;
};

export type MigrationStockData = {
  accounts: MarketplaceAccount[];
  summary: MigrationStockSummary;
  rows: MigrationStockRow[];
  errors: string[];
};

export async function getMigrationStockData(view: MigrationStockView = "marketplace-only"): Promise<MigrationStockData> {
  const errors = await syncActiveMarketplaceInventory();
  const [products, links, accounts] = await Promise.all([
    getSystemProducts(),
    getMarketplaceLinks(),
    getActiveMarketplaceAccounts()
  ]);
  const context = buildContext(products, links, accounts);

  return {
    accounts,
    summary: {
      marketplaceOnly: context.marketplaceOnly.length,
      systemOnly: context.systemOnly.length,
      missingMarketplace: context.missingMarketplace.length,
      stockDivergent: context.stockDivergent.length
    },
    rows: context[viewKey(view)],
    errors
  };
}

export async function importMarketplaceSku(sku: string) {
  const normalizedSku = normalizeSku(sku);
  const supabase = supabaseAdmin();
  const links = await getMarketplaceLinksBySku(normalizedSku);
  if (links.length === 0) {
    throw new Error("SKU nao encontrado nas integracoes.");
  }

  const existing = await supabase.from("products").select("id").eq("sku", normalizedSku).maybeSingle().throwOnError();
  if (existing.data?.id) {
    await linkMarketplaceRowsToProduct(normalizedSku, existing.data.id);
    await syncListingsFromMarketplaceRows(normalizedSku, existing.data.id);
    return;
  }

  const typeCode = await inferTypeCode(normalizedSku);
  const brandCode = await getFirstBrandCode();
  const first = links[0];
  const product = await supabase
    .from("products")
    .insert({
      sku: normalizedSku,
      source_key: `marketplace_${normalizedSku}`,
      type_code: typeCode,
      brand_code: brandCode,
      title: first.titulo_marketplace || normalizedSku,
      description: first.titulo_marketplace || normalizedSku,
      price: first.valor_marketplace || 0,
      stock: maxStock(links),
      status: "active"
    })
    .select("id")
    .single()
    .throwOnError();

  await linkMarketplaceRowsToProduct(normalizedSku, product.data.id);
  await syncListingsFromMarketplaceRows(normalizedSku, product.data.id);
  await logMigration(normalizedSku, "cadastrar", "sucesso", "Produto importado do marketplace.", { productId: product.data.id });
}

export async function sendSystemProductToMissingMarketplaces(sku: string) {
  await logMigration(sku, "enviar_marketplaces_faltantes", "pendente", "Envio real de novos anuncios sera tratado na etapa de publicacao.", {});
}

export async function deleteSystemProductOnly(sku: string) {
  const supabase = supabaseAdmin();
  const product = await supabase.from("products").select("id").eq("sku", normalizeSku(sku)).single().throwOnError();
  await supabase.from("products").delete().eq("id", product.data.id).throwOnError();
  await logMigration(sku, "excluir_produto_sistema", "sucesso", "Produto excluido do sistema.", {});
}

export async function removeMarketplaceListingsForSku(sku: string) {
  const links = await getMarketplaceLinksBySku(normalizeSku(sku));
  for (const link of links) {
    try {
      if (link.marketplace === "mercado_livre") {
        await removeMercadoLivreListing(link.marketplace_account_id, link.marketplace_product_id);
      }
      await markLinkAsRemoved(link);
      await logMigration(sku, "remover_anuncio_marketplace", "sucesso", "Anuncio removido/inativado no marketplace.", link);
    } catch (error) {
      await logMigration(sku, "remover_anuncio_marketplace", "erro", errorMessage(error), link);
      throw error;
    }
  }
}

export async function updateDivergentStockByLowest(sku: string) {
  const normalizedSku = normalizeSku(sku);
  const supabase = supabaseAdmin();
  const product = await supabase.from("products").select("id,stock").eq("sku", normalizedSku).single().throwOnError();
  const links = await getMarketplaceLinksBySku(normalizedSku);
  const stocks = [Number(product.data.stock || 0), ...links.map((link) => effectiveMarketplaceStock(link))];
  const lowest = Math.min(...stocks);

  await supabase
    .from("products")
    .update({ stock: lowest, status: lowest <= 0 ? "paused" : "active", updated_at: new Date().toISOString() })
    .eq("id", product.data.id)
    .throwOnError();

  for (const link of links) {
    try {
      if (link.marketplace === "mercado_livre") {
        await updateMercadoLivreStock(link.marketplace_account_id, link.marketplace_product_id, lowest);
        await markLinkAsInactive(link, lowest, lowest <= 0 ? "paused" : "active");
      }
      await logMigration(normalizedSku, "atualizar_estoque", "sucesso", `Estoque atualizado para ${lowest}.`, link);
    } catch (error) {
      await logMigration(normalizedSku, "atualizar_estoque", "erro", errorMessage(error), link);
      throw error;
    }
  }
}

async function syncActiveMarketplaceInventory() {
  const accounts = await getActiveMercadoLivreAccounts();
  const errors: string[] = [];

  for (const account of accounts) {
    try {
      const items = await listMercadoLivreInventory(account);
      for (const item of items) {
        await upsertMarketplaceItem(item);
      }
    } catch (error) {
      const message = `${account.name}: ${errorMessage(error)}`;
      errors.push(message);
      await logMigration("", "sincronizar_marketplace", "erro", message, { accountId: account.id });
    }
  }

  await relinkMarketplaceProducts();
  return errors;
}

async function upsertMarketplaceItem(item: {
  accountId: string;
  marketplace: "mercado_livre";
  listingId: string;
  sku: string;
  title: string;
  price: number;
  stock: number;
  status: string;
  rawData: Record<string, unknown>;
}) {
  const supabase = supabaseAdmin();
  const sku = normalizeSku(item.sku);
  const product = await supabase.from("products").select("id").eq("sku", sku).maybeSingle().throwOnError();

  await supabase.from("product_marketplaces").upsert({
    product_id: product.data?.id || null,
    sku,
    marketplace_account_id: item.accountId,
    marketplace: item.marketplace,
    marketplace_product_id: item.listingId,
    titulo_marketplace: item.title,
    valor_marketplace: item.price,
    estoque_marketplace: item.stock,
    status_anuncio: item.status,
    existe_no_marketplace: true,
    raw_data: item.rawData,
    updated_at: new Date().toISOString()
  }, { onConflict: "marketplace_account_id,marketplace_product_id" }).throwOnError();
}

async function relinkMarketplaceProducts() {
  const [products, links] = await Promise.all([getSystemProducts(), getMarketplaceLinks()]);
  const productBySku = new Map(products.map((product) => [normalizeSku(product.sku), product.id]));
  const supabase = supabaseAdmin();

  for (const link of links) {
    const productId = productBySku.get(normalizeSku(link.sku));
    if (productId && link.product_id !== productId) {
      await supabase.from("product_marketplaces").update({ product_id: productId }).eq("id", link.id);
    }
  }
}

function buildContext(products: SystemProduct[], links: MarketplaceLink[], accounts: MarketplaceAccount[]) {
  const productBySku = new Map(products.map((product) => [normalizeSku(product.sku), product]));
  const linksBySku = groupLinksBySku(links);
  const allAccountIds = accounts.map((account) => account.id);

  const marketplaceOnly: MigrationStockRow[] = [];
  const systemOnly: MigrationStockRow[] = [];
  const missingMarketplace: MigrationStockRow[] = [];
  const stockDivergent: MigrationStockRow[] = [];

  for (const [sku, skuLinks] of linksBySku.entries()) {
    const product = productBySku.get(sku);
    if (!product) {
      marketplaceOnly.push(toRow(sku, undefined, skuLinks));
    }
  }

  for (const product of products) {
    const sku = normalizeSku(product.sku);
    const skuLinks = linksBySku.get(sku) || [];
    const linkedAccountIds = new Set(skuLinks.map((link) => link.marketplace_account_id));

    if (skuLinks.length === 0) {
      systemOnly.push(toRow(sku, product, []));
      continue;
    }

    if (allAccountIds.some((accountId) => !linkedAccountIds.has(accountId))) {
      missingMarketplace.push(toRow(sku, product, skuLinks));
    }

    if (hasDivergentStock(product, skuLinks)) {
      stockDivergent.push(toRow(sku, product, skuLinks));
    }
  }

  return {
    marketplaceOnly: marketplaceOnly.sort(bySku),
    systemOnly: systemOnly.sort(bySku),
    missingMarketplace: missingMarketplace.sort(bySku),
    stockDivergent: stockDivergent.sort(bySku)
  };
}

function toRow(sku: string, product: SystemProduct | undefined, links: MarketplaceLink[]): MigrationStockRow {
  return {
    sku,
    title: product?.title || links[0]?.titulo_marketplace || sku,
    price: product?.price ?? links[0]?.valor_marketplace ?? 0,
    systemStock: product?.stock,
    productId: product?.id,
    marketplaces: links
  };
}

async function getSystemProducts() {
  const { data } = await supabaseAdmin()
    .from("products")
    .select("id,sku,title,description,price,stock,status")
    .order("sku")
    .throwOnError();

  return (data ?? []) as SystemProduct[];
}

async function getActiveMarketplaceAccounts() {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id,name,marketplace")
    .eq("active", true)
    .order("name")
    .throwOnError();

  return (data ?? []) as MarketplaceAccount[];
}

async function getMarketplaceLinks() {
  const { data } = await supabaseAdmin()
    .from("product_marketplaces")
    .select("*")
    .eq("existe_no_marketplace", true)
    .throwOnError();

  return (data ?? []) as MarketplaceLink[];
}

async function getMarketplaceLinksBySku(sku: string) {
  const { data } = await supabaseAdmin()
    .from("product_marketplaces")
    .select("*")
    .eq("sku", normalizeSku(sku))
    .eq("existe_no_marketplace", true)
    .throwOnError();

  return (data ?? []) as MarketplaceLink[];
}

async function linkMarketplaceRowsToProduct(sku: string, productId: string) {
  await supabaseAdmin()
    .from("product_marketplaces")
    .update({ product_id: productId, updated_at: new Date().toISOString() })
    .eq("sku", normalizeSku(sku))
    .throwOnError();
}

async function syncListingsFromMarketplaceRows(sku: string, productId: string) {
  const links = await getMarketplaceLinksBySku(sku);
  const supabase = supabaseAdmin();

  for (const link of links) {
    const payload = {
      product_id: productId,
      marketplace: link.marketplace,
      marketplace_account_id: link.marketplace_account_id,
      marketplace_name: link.marketplace_account_id,
      external_listing_id: link.marketplace_product_id,
      external_sku: normalizeSku(sku),
      status: link.status_anuncio === "active" ? "active" : "paused",
      stock: effectiveMarketplaceStock(link),
      price: link.valor_marketplace || 0,
      last_sync_at: new Date().toISOString(),
      error_message: null
    };

    const result = await supabase
      .from("listings")
      .upsert(payload, { onConflict: "product_id,marketplace_account_id" });

    if (result.error) {
      await supabase.from("listings").insert(payload);
    }
  }
}

async function markLinkAsInactive(link: MarketplaceLink, stock: number, status: string) {
  await supabaseAdmin()
    .from("product_marketplaces")
    .update({
      estoque_marketplace: stock,
      status_anuncio: status,
      existe_no_marketplace: status !== "removed",
      updated_at: new Date().toISOString()
    })
    .eq("id", link.id)
    .throwOnError();
}

async function markLinkAsRemoved(link: MarketplaceLink) {
  await supabaseAdmin()
    .from("product_marketplaces")
    .update({
      estoque_marketplace: 0,
      status_anuncio: "paused",
      existe_no_marketplace: false,
      updated_at: new Date().toISOString()
    })
    .eq("id", link.id)
    .throwOnError();
}

async function inferTypeCode(sku: string) {
  const suffix = sku.slice(-2);
  const supabase = supabaseAdmin();
  const exact = await supabase.from("config_types").select("code").eq("code", suffix).maybeSingle().throwOnError();
  if (exact.data?.code) {
    return exact.data.code;
  }

  const first = await supabase.from("config_types").select("code").order("code").limit(1).single().throwOnError();
  return first.data.code;
}

async function getFirstBrandCode() {
  const { data } = await supabaseAdmin().from("config_brands").select("code").order("code").limit(1).single().throwOnError();
  return data.code;
}

function groupLinksBySku(links: MarketplaceLink[]) {
  const map = new Map<string, MarketplaceLink[]>();
  for (const link of links) {
    const sku = normalizeSku(link.sku);
    const current = map.get(sku) || [];
    current.push(link);
    map.set(sku, current);
  }
  return map;
}

function hasDivergentStock(product: SystemProduct, links: MarketplaceLink[]) {
  const systemStock = Number(product.stock || 0);
  return links.some((link) => effectiveMarketplaceStock(link) !== systemStock);
}

export function effectiveMarketplaceStock(link: MarketplaceLink) {
  if (link.marketplace === "mercado_livre" && isMercadoLivreInactive(link.status_anuncio || "")) {
    return 0;
  }

  return Number(link.estoque_marketplace || 0);
}

function maxStock(links: MarketplaceLink[]) {
  return Math.max(0, ...links.map((link) => effectiveMarketplaceStock(link)));
}

function viewKey(view: MigrationStockView) {
  const map = {
    "marketplace-only": "marketplaceOnly",
    "system-only": "systemOnly",
    "missing-marketplace": "missingMarketplace",
    "stock-divergent": "stockDivergent"
  } as const;
  return map[view];
}

function bySku(a: MigrationStockRow, b: MigrationStockRow) {
  return a.sku.localeCompare(b.sku);
}

function normalizeSku(sku: string) {
  return String(sku || "").trim().toUpperCase();
}

async function logMigration(sku: string, acao: string, status: string, mensagem: string, detalhes: unknown) {
  await supabaseAdmin().from("migration_stock_logs").insert({
    sku: sku || null,
    acao,
    status,
    mensagem,
    detalhes
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
