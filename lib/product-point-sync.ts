import { getActiveMercadoLivreAccounts, listMercadoLivreInventory } from "./mercado-livre";
import { upsertMarketplaceItem } from "./migration-stock";
import { importMarketplaceSku } from "./migration-stock";
import { getActiveShopeeAccounts, listShopeeInventory } from "./shopee";
import { supabaseAdmin } from "./supabase-admin";
import { findTinyProductBySku, getTinyProductSnapshot } from "./tiny";
import { clearTinyLink, isTinyNotFoundError, reconcileProductIntegrationStatus } from "./product-integration-status";
import { ensureProductMarketplaceCategoryFallbacks } from "./marketplace-attributes";

type ListingResult = {
  marketplace: string;
  account: string;
  listingId: string;
  title: string;
  previousLink: "solto" | "mesmo_produto" | "outro_produto";
  previousProductSku?: string;
};

export type PointSyncResult = {
  sku: string;
  mode: "TINY" | "MARKETPLACE_DIRETO";
  tinyFields: string[];
  listings: ListingResult[];
  removedLinks: string[];
  errors: string[];
};

export async function synchronizeProductById(productId: string): Promise<PointSyncResult> {
  const db = supabaseAdmin();
  const [productResult, modeResult] = await Promise.all([
    db.from("products").select("id,sku,tiny_product_id").eq("id", productId).single().throwOnError(),
    db.from("settings").select("value").eq("key", "PRODUCT_SEND_TARGET").maybeSingle().throwOnError()
  ]);
  const product = productResult.data;
  const sku = normalizeSku(product.sku);
  const mode = String(modeResult.data?.value || "TINY") === "MARKETPLACE_DIRETO" ? "MARKETPLACE_DIRETO" : "TINY";
  const result: PointSyncResult = { sku, mode, tinyFields: [], listings: [], removedLinks: [], errors: [] };

  if (mode === "TINY") {
    try {
      result.tinyFields = await synchronizeTinyProduct(productId, sku, product.tiny_product_id ? String(product.tiny_product_id) : "");
    } catch (error) {
      if (isTinyNotFoundError(error)) {
        try {
          const replacement = await findTinyProductBySku(sku);
          if (replacement?.id) {
            result.tinyFields = await synchronizeTinyProduct(productId, sku, String(replacement.id));
          } else {
            await clearTinyLink(productId);
            result.removedLinks.push(`Tiny: vinculo removido porque o SKU ${sku} nao existe mais no Tiny.`);
          }
        } catch (lookupError) {
          result.errors.push(`Tiny: ${errorMessage(lookupError)}`);
        }
      } else {
        result.errors.push(`Tiny: ${errorMessage(error)}`);
      }
    }
  }

  await synchronizeMarketplaceListings(productId, sku, result);
  await ensureProductMarketplaceCategoryFallbacks(productId);
  const hasAnyLink = await reconcileProductIntegrationStatus(productId);
  if (!hasAnyLink) result.removedLinks.push("Produto sem vinculos ativos: status alterado para pendente de envio.");
  await writePointSyncLog(result);
  return result;
}

export async function synchronizeProductBySku(skuValue: string): Promise<PointSyncResult> {
  const sku = normalizeSku(skuValue);
  if (!sku) throw new Error("SKU nao informado.");
  const db = supabaseAdmin();
  let product = await db.from("products").select("id").ilike("sku", sku).maybeSingle().throwOnError();
  if (!product.data?.id) {
    const mode = await db.from("settings").select("value").eq("key", "PRODUCT_SEND_TARGET").maybeSingle().throwOnError();
    await importMarketplaceSku(sku, String(mode.data?.value || "TINY") !== "MARKETPLACE_DIRETO");
    product = await db.from("products").select("id").ilike("sku", sku).maybeSingle().throwOnError();
  }
  if (!product.data?.id) throw new Error(`Nao foi possivel localizar ou cadastrar o SKU ${sku}.`);
  return synchronizeProductById(String(product.data.id));
}

async function synchronizeTinyProduct(productId: string, sku: string, currentTinyId: string) {
  const tinyProduct = currentTinyId ? { id: currentTinyId } : await findTinyProductBySku(sku);
  if (!tinyProduct?.id) throw new Error(`produto com SKU ${sku} nao encontrado.`);
  const detail = await getTinyProductSnapshot(String(tinyProduct.id)) as Record<string, unknown>;
  const title = String(detail.nome || sku).trim();
  const description = String(detail.descricao_complementar ?? detail.descricao ?? detail.obs ?? "").trim() || null;
  const price = Number(detail.preco ?? detail.preco_promocional ?? 0) || 0;
  const stock = Math.max(0, Math.trunc(Number(detail.saldo ?? detail.estoque_atual ?? 0) || 0));
  const db = supabaseAdmin();
  await db.from("products").update({
    tiny_product_id: String(tinyProduct.id), title, description, price, stock,
    status: "sent", sent_target: "TINY", tiny_last_synced_on: today(), updated_at: new Date().toISOString()
  }).eq("id", productId).throwOnError();
  await db.from("estoque").upsert({ product_id: productId, sku }, { onConflict: "product_id" }).throwOnError();
  await db.rpc("set_physical_inventory", { p_product_id: productId, p_quantity: stock }).throwOnError();
  return [
    `ID Tiny: ${tinyProduct.id}`,
    `Titulo: ${title}`,
    `Descricao: ${description || "vazia"}`,
    `Preco: ${price.toFixed(2)}`,
    `Estoque fisico: ${stock}`
  ];
}

async function synchronizeMarketplaceListings(productId: string, sku: string, result: PointSyncResult) {
  const accountGroups = await Promise.allSettled([getActiveMercadoLivreAccounts(), getActiveShopeeAccounts()]);
  const accounts = accountGroups.flatMap((group) => group.status === "fulfilled" ? group.value : []);
  for (const group of accountGroups) {
    if (group.status === "rejected") result.errors.push(`Contas de marketplace: ${errorMessage(group.reason)}`);
  }

  for (const account of accounts) {
    try {
      const inventory = account.marketplace === "shopee"
        ? await listShopeeInventory(account)
        : await listMercadoLivreInventory(account);
      const matches = inventory.filter((item) => normalizeSku(item.sku) === sku);
      for (const item of matches) {
        const previous = await previousListingState(productId, item.accountId, item.listingId);
        await upsertMarketplaceItem({
          accountId: item.accountId,
          marketplace: item.marketplace,
          listingId: item.listingId,
          sku,
          title: item.title,
          price: item.price,
          stock: item.stock,
          status: item.status,
          rawData: item.rawData
        });
        const linked = await marketplaceListingIsLinked(productId, item.accountId, item.listingId);
        if (linked) {
          result.listings.push({
            marketplace: item.marketplace,
            account: item.accountName,
            listingId: item.listingId,
            title: item.title,
            previousLink: previous.state,
            previousProductSku: previous.sku
          });
        } else {
          result.errors.push(`${item.accountName}: anuncio ${item.listingId} foi encontrado, mas o vinculo nao foi confirmado no banco.`);
        }
      }
      const matchedIds = matches.map((item) => item.listingId);
      const removed = await removeMissingMarketplaceLinks(productId, account.id, matchedIds);
      result.removedLinks.push(...removed.map((listingId) => `${account.name}: vinculo do anuncio ${listingId} removido porque nao existe mais nesta conta.`));
    } catch (error) {
      result.errors.push(`${account.name}: ${errorMessage(error)}`);
    }
  }
}

async function marketplaceListingIsLinked(productId: string, accountId: string, listingId: string) {
  const db = supabaseAdmin();
  const [marketplaceLink, listingLink] = await Promise.all([
    db.from("product_marketplaces").select("id").eq("product_id", productId)
      .eq("marketplace_account_id", accountId).eq("marketplace_product_id", listingId)
      .eq("existe_no_marketplace", true).maybeSingle().throwOnError(),
    db.from("listings").select("id").eq("product_id", productId)
      .eq("marketplace_account_id", accountId).eq("external_listing_id", listingId)
      .maybeSingle().throwOnError()
  ]);
  return Boolean(marketplaceLink.data?.id && listingLink.data?.id);
}

async function removeMissingMarketplaceLinks(productId: string, accountId: string, matchedIds: string[]) {
  const db = supabaseAdmin();
  const [marketplaceRows, listingRows] = await Promise.all([
    db.from("product_marketplaces").select("id,marketplace_product_id")
      .eq("product_id", productId).eq("marketplace_account_id", accountId).throwOnError(),
    db.from("listings").select("id,external_listing_id")
      .eq("product_id", productId).eq("marketplace_account_id", accountId).throwOnError()
  ]);
  const keep = new Set(matchedIds);
  const staleMarketplace = (marketplaceRows.data || []).filter((row) => !keep.has(String(row.marketplace_product_id)));
  const staleListings = (listingRows.data || []).filter((row) => !keep.has(String(row.external_listing_id)));
  if (staleMarketplace.length) await db.from("product_marketplaces").delete().in("id", staleMarketplace.map((row) => row.id)).throwOnError();
  if (staleListings.length) await db.from("listings").delete().in("id", staleListings.map((row) => row.id)).throwOnError();
  return [...new Set([...staleMarketplace.map((row) => String(row.marketplace_product_id)), ...staleListings.map((row) => String(row.external_listing_id))])];
}

async function previousListingState(productId: string, accountId: string, listingId: string) {
  const db = supabaseAdmin();
  const [marketplaceLink, listingLink] = await Promise.all([
    db.from("product_marketplaces").select("product_id")
      .eq("marketplace_account_id", accountId)
      .eq("marketplace_product_id", listingId)
      .maybeSingle().throwOnError(),
    db.from("listings").select("product_id")
      .eq("marketplace_account_id", accountId)
      .eq("external_listing_id", listingId)
      .maybeSingle().throwOnError()
  ]);
  const linkedProductId = marketplaceLink.data?.product_id || listingLink.data?.product_id;
  const previousProductId = linkedProductId ? String(linkedProductId) : "";
  if (!previousProductId) return { state: "solto" as const };
  if (previousProductId === productId) return { state: "mesmo_produto" as const };
  const previousProduct = await db.from("products").select("sku").eq("id", previousProductId).maybeSingle().throwOnError();
  return { state: "outro_produto" as const, sku: String(previousProduct.data?.sku || "nao identificado") };
}

async function writePointSyncLog(result: PointSyncResult) {
  const tinyLines = result.mode === "TINY"
    ? result.tinyFields.length ? ["Tiny:", ...result.tinyFields.map((line) => `- ${line}`)] : ["Tiny: nenhuma informacao atualizada."]
    : ["Tiny: nao processado (integracao direta com marketplaces)."];
  const listingLines = result.listings.length
    ? ["Anuncios encontrados e vinculados:", ...result.listings.map((item) => {
        const previous = item.previousLink === "solto"
          ? "estava solto, sem vinculo"
          : item.previousLink === "mesmo_produto"
            ? "ja estava vinculado a este produto"
            : `estava vinculado a outro produto (SKU ${item.previousProductSku})`;
        return `- ${marketplaceLabel(item.marketplace)} / ${item.account} / anuncio ${item.listingId}: ${previous}.`;
      })]
    : ["Anuncios encontrados e vinculados: nenhum."];
  const errorLines = result.errors.length ? ["Alertas:", ...result.errors.map((error) => `- ${error}`)] : [];
  const removedLines = result.removedLinks.length ? ["Vinculos removidos:", ...result.removedLinks.map((line) => `- ${line}`)] : [];
  const summary = [`SKU: ${result.sku}.`, `Modo: ${result.mode}.`, ...tinyLines, ...listingLines, ...removedLines, ...errorLines].join("\n");
  await supabaseAdmin().from("pipeline_logs").insert({
    level: result.errors.length ? "error" : "info",
    message: `Sincronismo pontual ${result.sku}`,
    payload: {
      stage: "stock_sync",
      process: `Sincronismo pontual ${result.sku}`,
      status: result.errors.length ? "failed" : "done",
      summary,
      sku: result.sku,
      mode: result.mode,
      tinyFields: result.tinyFields,
      listings: result.listings,
      removedLinks: result.removedLinks,
      errors: result.errors
    }
  }).throwOnError();
}

function normalizeSku(value: unknown) { return String(value || "").trim().toUpperCase(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); }
function marketplaceLabel(value: string) { return value === "shopee" ? "Shopee" : value === "mercado_livre" ? "Mercado Livre" : value; }
