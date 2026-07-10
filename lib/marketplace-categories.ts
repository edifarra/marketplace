import { getActiveShopeeAccounts, getValidShopeeAccessToken } from "./shopee";
import { createShopeeClient, getShopeeOAuthConfig } from "./shopee-oauth";
import { supabaseAdmin } from "./supabase-admin";

export type CategoryNode = { id: string; name: string; parentId: string | null; hasChildren: boolean; path?: string };

export async function listMarketplaceCategories(marketplace: string, parentId?: string | null): Promise<CategoryNode[]> {
  if (marketplace === "mercado_livre") return listMercadoLivre(parentId);
  if (marketplace === "shopee") return listShopee(parentId);
  if (marketplace === "tiny") return listTiny(parentId);
  throw new Error("Marketplace invalido.");
}

async function listMercadoLivre(parentId?: string | null) {
  const url = parentId ? `https://api.mercadolibre.com/categories/${encodeURIComponent(parentId)}` : "https://api.mercadolibre.com/sites/MLB/categories";
  const response = await fetch(url, { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new Error(`Mercado Livre: ${JSON.stringify(json)}`);
  const rows = parentId ? json.children_categories || [] : json;
  return rows.map((row: Record<string, unknown>) => ({ id: String(row.id), name: String(row.name), parentId: parentId || null, hasChildren: Number(row.total_items_in_this_category || 0) > 0 }));
}

async function listShopee(parentId?: string | null) {
  const account = (await getActiveShopeeAccounts())[0];
  if (!account) throw new Error("Conecte uma conta Shopee antes de buscar categorias.");
  const shopId = account.shop_id || account.account_id;
  if (!shopId) throw new Error("Shop ID da Shopee ausente.");
  const token = await getValidShopeeAccessToken(account);
  const client = createShopeeClient(await getShopeeOAuthConfig(account.id));
  const json = await client.getCategories(token, shopId);
  const response = json.response as Record<string, unknown> | undefined;
  const rows = (response?.category_list || []) as Array<Record<string, unknown>>;
  return rows.filter(row => String(row.parent_category_id || "0") === String(parentId || "0")).map(row => ({
    id: String(row.category_id), name: String(row.display_category_name || row.original_category_name || row.category_name || row.category_id),
    parentId: parentId || null, hasChildren: Boolean(row.has_children)
  }));
}

async function listTiny(parentId?: string | null) {
  const { data } = await supabaseAdmin().from("settings").select("value").eq("key", "TINY_TOKEN").maybeSingle().throwOnError();
  const token = String(data?.value || process.env.TINY_TOKEN || "");
  if (!token) throw new Error("Token Tiny nao configurado.");
  const body = new URLSearchParams({ token, formato: "json" });
  const response = await fetch("https://api.tiny.com.br/api2/categorias.pesquisa.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store" });
  const json = await response.json();
  const retorno = json.retorno || {};
  if (retorno.status === "Erro") throw new Error(`Tiny: ${JSON.stringify(retorno.erros || retorno)}`);
  const rows = (retorno.categorias || retorno.registros || []) as Array<Record<string, any>>;
  return rows.map(entry => entry.categoria || entry.registro || entry).map(row => ({
    id: String(row.id || row.codigo || row.idCategoria), name: String(row.descricao || row.nome || row.categoria),
    parentId: row.idCategoriaPai ? String(row.idCategoriaPai) : null, hasChildren: Boolean(row.possuiFilhos || row.filhos?.length)
  })).filter(row => (row.parentId || null) === (parentId || null));
}
