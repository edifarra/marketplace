import { listMercadoLivreInventory, getActiveMercadoLivreAccounts, type MercadoLivreInventoryItem } from "./mercado-livre";
import { supabaseAdmin } from "./supabase-admin";

type SystemProduct = {
  id: string;
  sku: string;
  title: string;
  stock: number;
};

export type StockIntegrationColumn = {
  id: string;
  name: string;
};

export type StockIntegrationCell = {
  stock: number;
  status: string;
  listingIds: string[];
};

export type StockSystemRow = {
  system: "SIST";
  sku: string;
  title: string;
  stock: number;
  productId: string;
  integrations: Record<string, StockIntegrationCell | undefined>;
};

export type StockIntegrationOnlyRow = {
  system: "INTEG";
  sku: string;
  title: string;
  integrations: Record<string, StockIntegrationCell | undefined>;
};

export type StockConsolidationResult = {
  columns: StockIntegrationColumn[];
  systemRows: StockSystemRow[];
  integrationOnlyRows: StockIntegrationOnlyRow[];
  errors: string[];
};

export async function getStockConsolidation(): Promise<StockConsolidationResult> {
  const [products, marketplaceItems] = await Promise.all([
    getSystemProducts(),
    getMarketplaceInventoryItems()
  ]);

  const columns = uniqueColumns(marketplaceItems.items);
  const itemsBySku = groupItemsBySku(marketplaceItems.items);
  const productSkuSet = new Set(products.map((product) => normalizeSku(product.sku)));

  return {
    columns,
    systemRows: products.map((product) => ({
      system: "SIST",
      sku: product.sku,
      title: product.title,
      stock: Number(product.stock || 0),
      productId: product.id,
      integrations: buildIntegrationCells(itemsBySku.get(normalizeSku(product.sku)) || [])
    })),
    integrationOnlyRows: Array.from(itemsBySku.entries())
      .filter(([sku]) => !productSkuSet.has(sku))
      .map(([sku, items]) => ({
        system: "INTEG" as const,
        sku,
        title: items[0]?.title || "-",
        integrations: buildIntegrationCells(items)
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
    errors: marketplaceItems.errors
  };
}

async function getSystemProducts() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("products")
    .select("id,sku,title,stock")
    .order("sku")
    .throwOnError();

  return (data ?? []) as SystemProduct[];
}

async function getMarketplaceInventoryItems() {
  const accounts = await getActiveMercadoLivreAccounts();
  const items: MercadoLivreInventoryItem[] = [];
  const errors: string[] = [];

  for (const account of accounts) {
    try {
      items.push(...await listMercadoLivreInventory(account));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${account.name}: ${message}`);
      await supabaseAdmin()
        .from("config_marketplace_accounts")
        .update({ last_error: message })
        .eq("id", account.id);
    }
  }

  return { items, errors };
}

function uniqueColumns(items: MercadoLivreInventoryItem[]) {
  const map = new Map<string, StockIntegrationColumn>();
  for (const item of items) {
    map.set(item.accountId, { id: item.accountId, name: item.accountName });
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function groupItemsBySku(items: MercadoLivreInventoryItem[]) {
  const map = new Map<string, MercadoLivreInventoryItem[]>();
  for (const item of items) {
    const sku = normalizeSku(item.sku);
    if (!sku) {
      continue;
    }

    const current = map.get(sku) || [];
    current.push(item);
    map.set(sku, current);
  }

  return map;
}

function buildIntegrationCells(items: MercadoLivreInventoryItem[]) {
  const cells: Record<string, StockIntegrationCell> = {};
  for (const item of items) {
    const current = cells[item.accountId] || {
      stock: 0,
      status: "",
      listingIds: []
    };
    current.stock += item.stock;
    current.status = mergeStatus(current.status, item.status);
    current.listingIds.push(item.listingId);
    cells[item.accountId] = current;
  }

  return cells;
}

function mergeStatus(current: string, next: string) {
  if (!current) {
    return next;
  }

  return current === next ? current : "misto";
}

function normalizeSku(sku: string) {
  return String(sku || "").trim().toUpperCase();
}
