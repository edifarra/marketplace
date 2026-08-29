import { Sidebar } from "@/app/components/sidebar";
import { resendProductIntegrationAction } from "../actions";
import { IntegrationDeleteButton } from "./integration-delete-button";
import { buildProductDescription } from "@/lib/dynamic-product-description";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ProductEditor } from "./product-editor";
import { validateMarketplaceImage } from "@/lib/marketplace-image-validation";
import { recoverTemporaryImagesWhenCloudinaryIsUnavailable } from "@/lib/marketplace-temporary-images";
import { resolveEffectiveProduct } from "@/lib/effective-product";
import { fetchMarketplaceCategoryDefinition, type MarketplaceDefinitions } from "@/lib/marketplace-attributes";
import { getMarketplaceCategoryPath } from "@/lib/marketplace-categories";
import { getProductActionState } from "@/lib/product-action-rules";
import { ProductQueueWaiter } from "../product-queue-waiter";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ProductDetail = {
  id: string;
  sku: string;
  source_key: string;
  type_code: string;
  brand_code: string;
  special_code: string | null;
  product_condition: "new" | "used";
  model: string | null;
  version: string | null;
  board_code: string | null;
  title: string;
  price: number;
  stock: number;
  status: string;
  sent_target?: string | null;
  sent_at?: string | null;
  tiny_product_id?: string | null;
  mercado_livre_parent_listing_id?: string | null;
  mercado_livre_variation_id?: number | null;
  created_at: string;
  product_images: Array<{
    id: string;
    original_name: string;
    url: string | null;
    local_url?: string | null;
    cloudinary_url?: string | null;
    position: number;
    status: string;
    bytes?: number | null;
    width_px?: number | null;
    height_px?: number | null;
  }>;
  listings: Array<{
    id: string;
    marketplace: string;
    external_listing_id: string | null;
    external_sku: string | null;
    status: string;
    stock: number;
    price: number;
    error_message: string | null;
    last_sync_at?: string | null;
    marketplace_name?: string | null;
    external_url?: string | null;
    marketplace_account_id?: string | null;
    marketplace_shop_id?: string | null;
    moderation_reason?: string | null;
    parent_listing_id?: string | null;
    variation_id?: string | null;
  }>;
};

type IntegrationRow = {
  key: string;
  integration: "TINY" | "MERCADO_LIVRE" | "SHOPEE";
  name: string;
  code: string;
  sku: string;
  status: string;
  sentAt: string;
  canRemove: boolean;
  url: string;
  accountId: string;
  parentListingId?: string;
  variationId?: string;
  moderationReason?: string;
};

export default async function ProductDetailPage({
  params,
  searchParams
}: {
  params: { id: string };
  searchParams?: { erro?: string; sucesso?: string; returnTo?: string; fila?: string; aguardando?: string };
}) {
  const product = await getProduct(params.id);

  if (!product) {
    return (
      <main className="shell">
        <Sidebar />
        <section className="main">
          <h1>Produto nao encontrado</h1>
        </section>
      </main>
    );
  }

  const typed = product as ProductDetail;
  const supabase = supabaseAdmin();
  const requestedReturn = String(searchParams?.returnTo || "/produtos");
  const returnTo = requestedReturn.startsWith("/produtos") && !requestedReturn.startsWith("//") ? requestedReturn : "/produtos";
  const integrations = buildIntegrationRows(typed);
  const temporaryImages = await recoverTemporaryImagesWhenCloudinaryIsUnavailable(typed.id, typed.product_images || []);
  const imagesValid = (typed.product_images || []).length > 0 && (typed.product_images || []).every(image => validateMarketplaceImage({ width: Number(image.width_px), height: Number(image.height_px), bytes: Number(image.bytes) }).length === 0);
  const [{ data: type }, { data: brand }, { data: special }, types, brands, specials, categoryMappings, inventory, marketplaceState, sendTarget, activeAccounts] = await Promise.all([
    supabase.from("config_types").select("*").eq("code", typed.type_code).maybeSingle(),
    supabase.from("config_brands").select("*").eq("code", typed.brand_code).maybeSingle(),
    typed.special_code
      ? supabase.from("config_specials").select("*").eq("code", typed.special_code).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("config_types").select("code,description,marketplace_category,marketplace_active_attributes").order("description"),
    supabase.from("config_brands").select("code,name").order("name"),
    supabase.from("config_specials").select("code,notes,include_description").order("code"),
    supabase.from("marketplace_category_mappings").select("*").order("internal_category"),
    supabase.from("estoque").select("estoque_fisico,estoque_disponivel").eq("product_id", typed.id).maybeSingle(),
    supabase.from("product_marketplaces").select("marketplace,status_anuncio,raw_data,family_id,family_name,user_product_id,updated_at").eq("product_id", typed.id).eq("existe_no_marketplace", true).order("updated_at"),
    supabase.from("settings").select("value").eq("key", "PRODUCT_SEND_TARGET").maybeSingle(),
    supabase.from("config_marketplace_accounts").select("id").in("marketplace", ["mercado_livre", "shopee"]).eq("active", true)
  ]);
  const actionState = getProductActionState(String(sendTarget.data?.value || "TINY") === "MARKETPLACE_DIRETO" ? "MARKETPLACE_DIRETO" : "TINY", (activeAccounts.data || []).map(account => String(account.id)), {
    tinyProductId: typed.tiny_product_id,
    marketplaceLinks: (typed.listings || []).map(listing => ({ accountId: listing.marketplace_account_id, externalId: listing.external_listing_id }))
  });
  const actionReturnTo = `/produtos/${typed.id}?returnTo=${encodeURIComponent(returnTo)}`;
  const description = removeSpecialFragments(
    buildProductDescription(typed, type, brand, special),
    String(special?.remove_description || "")
  );

  const typeMapping = (categoryMappings.data || []).find(item => item.internal_category === type?.marketplace_category);
  const listingDefinitions: MarketplaceDefinitions = {};
  const resolvedMarketplaceState = await Promise.all((marketplaceState.data || []).map(async link => {
    const marketplace = String(link.marketplace) as "mercado_livre" | "shopee";
    const categoryId = String((link.raw_data as any)?.category_id || "");
    const defaultId = String((typeMapping as any)?.[`${marketplace}_code`] || "");
    if (!categoryId || categoryId === defaultId || listingDefinitions[marketplace]) return link;
    const categoryName = await getMarketplaceCategoryPath(marketplace, categoryId).catch(() => "");
    listingDefinitions[marketplace] = await fetchMarketplaceCategoryDefinition(marketplace, categoryId, categoryName).catch(() => undefined);
    return { ...link, effective_category_name: categoryName };
  }));
  const editable = { ...resolveEffectiveProduct({ product: { ...typed, description }, type, brand, special, inventory: inventory.data,
    mapping: typeMapping, marketplaceLinks: resolvedMarketplaceState, listingDefinitions }), description,
    mercado_livre_managed_title: resolvedMarketplaceState.some(link => String(link.marketplace) === "mercado_livre"
      && Boolean((link as any).family_id || (link.raw_data as any)?.family_id || (link as any).family_name || (link.raw_data as any)?.family_name)) };
  const editorCategoryMappings = (categoryMappings.data || []).map(item => item.internal_category === typeMapping?.internal_category
    ? { ...item, attribute_definitions: { ...(item.attribute_definitions || {}), ...listingDefinitions } }
    : item);

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
        {searchParams?.fila && <ProductQueueWaiter activityIds={searchParams.fila.split(",").filter(Boolean)} returnTo={actionReturnTo} initialMessage={searchParams.aguardando || "Envio registrado. Aguardando execução da fila..."} />}

        <ProductEditor product={editable as unknown as Record<string, string | number | null>}
          types={(types.data || []).map(item => ({ code: item.code, label: `${item.code} - ${item.description}`, marketplaceCategory: String(item.marketplace_category || ""), boardCodeRequired: isBoardCodeRequired(item, categoryMappings.data || []) }))}
          brands={(brands.data || []).map(item => ({ code: item.code, label: `${item.code} - ${item.name}` }))}
          specials={(specials.data || []).map(item => ({ code: item.code, label: `${item.code} - ${item.notes || item.include_description || item.code}` }))}
          images={(typed.product_images || []).map(image => ({ id: image.id, name: image.original_name, url: image.cloudinary_url || image.local_url || image.url || "", position: image.position, bytes: Number(image.bytes || 0), width: Number(image.width_px || 0), height: Number(image.height_px || 0) })).filter(image => image.url)}
          temporaryImages={temporaryImages}
          categoryMappings={editorCategoryMappings as any}
          marketplaceLinks={{
            mercado_livre: integrations.some(item => item.integration === "MERCADO_LIVRE"),
            shopee: integrations.some(item => item.integration === "SHOPEE")
          }} returnTo={returnTo} actionReturnTo={actionReturnTo} showSend={actionState.showSend} />

        <section className="section card product-integration-history">
          <h2>Envios realizados</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Integracao</th>
                  <th>Vinculacao</th>
                  <th>Anuncio Principal</th>
                  <th>ID da Variacao</th>
                  <th>SKU externo</th>
                  <th>Status</th>
                  <th>Ultimo envio</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {integrations.length === 0 ? (
                  <tr>
                    <td colSpan={8}>Nenhum envio realizado.</td>
                  </tr>
                ) : (
                  integrations.map((integration) => (
                    <tr key={integration.key}>
                      <td>{integration.name}</td>
                      <td><a href={integration.url} target="_blank" rel="noopener noreferrer" className="external-product-link">{integration.code}</a></td>
                      <td>{integration.parentListingId || "-"}</td>
                      <td>{integration.variationId || "-"}</td>
                      <td>{integration.sku}</td>
                      <td>{formatProductStatus(integration.status)}{integration.moderationReason ? <div className="muted">{integration.moderationReason}</div> : null}</td>
                      <td>{integration.sentAt}</td>
                      <td>
                        <div className="row-actions">
                          <form action={resendProductIntegrationAction}>
                            <input type="hidden" name="productId" value={typed.id} />
                            <input type="hidden" name="integration" value={integration.integration} />
                            <input type="hidden" name="externalId" value={integration.code} />
                            <input type="hidden" name="accountId" value={integration.accountId} />
                            <button className="secondary compact" type="submit" disabled={!imagesValid} title={!imagesValid ? "Corrigir fotos fora do padrão" : undefined}>Reenviar/Atualizar</button>
                          </form>
                          {integration.canRemove ? (
                            <IntegrationDeleteButton productId={typed.id} integration={integration.integration} externalId={integration.code} accountId={integration.accountId} />
                          ) : (
                            <span className="muted">Exclusao externa pendente</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}

function isBoardCodeRequired(type: Record<string, any>, mappings: Record<string, any>[]) {
  const mapping = mappings.find(item => item.internal_category === type.marketplace_category);
  const active = type.marketplace_active_attributes as Record<string, string[]> | null;
  return (["mercado_livre", "shopee"] as const).some(marketplace => Object.values(mapping?.attribute_definitions?.[marketplace]?.attributes || {}).some((attribute: any) =>
    attribute.systemSource === "board_code" && attribute.required && (active == null || active[marketplace] === undefined || active[marketplace].includes(String(attribute.id)))
  ));
}

async function getProduct(id: string) {
  const supabase = supabaseAdmin();
  const withLocalImages = await supabase
    .from("products")
    .select(`
      *,
      product_images (
        id,
        original_name,
        url,
        local_url,
        cloudinary_url,
        position,
        status,
        bytes,
        width_px,
        height_px
      ),
      listings (
        id,
        marketplace,
        external_listing_id,
        external_sku,
        status,
        stock,
        price,
        error_message,
        last_sync_at,
        marketplace_name,
        marketplace_account_id
      )
    `)
    .eq("id", id)
    .single();

  if (!withLocalImages.error) {
    return attachMarketplaceLinks(withLocalImages.data, id);
  }

  const fallback = await supabase
    .from("products")
    .select(`
      *,
      product_images (
        id,
        original_name,
        url,
        position,
        status,
        bytes,
        width_px,
        height_px
      ),
      listings (
        id,
        marketplace,
        external_listing_id,
        external_sku,
        status,
        stock,
        price,
        error_message,
        last_sync_at,
        marketplace_name,
        marketplace_account_id
      )
    `)
    .eq("id", id)
    .single();

  return attachMarketplaceLinks(fallback.data, id);
}

async function attachMarketplaceLinks(product: Record<string, unknown> | null, productId: string) {
  if (!product) return product;
  const supabase = supabaseAdmin();
  const [{ data }, { data: variations }] = await Promise.all([
    supabase.from("product_marketplaces")
      .select("id,marketplace,marketplace_product_id,marketplace_account_id,sku,status_anuncio,valor_marketplace,estoque_marketplace,updated_at,raw_data,config_marketplace_accounts(name,shop_id)")
      .eq("product_id", productId)
      .eq("existe_no_marketplace", true),
    supabase.from("product_marketplace_variations")
      .select("id,marketplace,marketplace_account_id,parent_listing_id,variation_id,sku,updated_at,config_marketplace_accounts(name,shop_id)")
      .eq("product_id", productId)
  ]);
  const original = (product.listings || []) as ProductDetail["listings"];
  const byExternalId = new Map<string, ProductDetail["listings"][number]>();
  for (const listing of original) {
    const key = `${listing.marketplace}:${listing.external_listing_id || listing.id}`;
    const saved = byExternalId.get(key);
    if (!saved || (!saved.marketplace_account_id && listing.marketplace_account_id)) {
      byExternalId.set(key, listing);
    }
  }
  const current = [...byExternalId.values()];
  const variationByListing = new Map<string, string[]>();
  for (const variation of variations || []) {
    const key = `${variation.marketplace_account_id}:${variation.parent_listing_id}`;
    variationByListing.set(key, [...(variationByListing.get(key) || []), String(variation.variation_id)]);
  }
  for (const link of data || []) {
    const variationIds = variationByListing.get(`${link.marketplace_account_id}:${link.marketplace_product_id}`) || [];
    const existing = current.find((item) => item.marketplace === link.marketplace && item.external_listing_id === link.marketplace_product_id);
    if (existing) {
      existing.status = String(link.status_anuncio || existing.status || "");
      existing.stock = Number(link.estoque_marketplace || 0);
      existing.price = Number(link.valor_marketplace || existing.price || 0);
      existing.last_sync_at = link.updated_at ? String(link.updated_at) : existing.last_sync_at;
      const account = link.config_marketplace_accounts as { name?: string; shop_id?: string } | null;
      existing.marketplace_name = String(account?.name || existing.marketplace_name || "");
      existing.marketplace_account_id = String(link.marketplace_account_id || existing.marketplace_account_id || "");
      existing.marketplace_shop_id = String(account?.shop_id || existing.marketplace_shop_id || "");
      existing.external_url = String((link.raw_data as { permalink?: string } | null)?.permalink || mercadoLivreUrl(String(link.marketplace_product_id)));
      existing.moderation_reason = String((link.raw_data as { moderation_reason?: string } | null)?.moderation_reason || "");
      existing.parent_listing_id = String(link.marketplace_product_id || "");
      existing.variation_id = variationIds.join(", ");
      continue;
    }
    current.push({
      id: String(link.id),
      marketplace: String(link.marketplace),
      external_listing_id: String(link.marketplace_product_id),
      external_sku: String(link.sku || ""),
      status: String(link.status_anuncio || ""),
      stock: Number(link.estoque_marketplace || 0),
      price: Number(link.valor_marketplace || 0),
      error_message: null,
      last_sync_at: link.updated_at ? String(link.updated_at) : null
      ,marketplace_name: String((link.config_marketplace_accounts as { name?: string } | null)?.name || "")
      ,external_url: String((link.raw_data as { permalink?: string } | null)?.permalink || mercadoLivreUrl(String(link.marketplace_product_id)))
      ,marketplace_account_id: String(link.marketplace_account_id || "")
      ,marketplace_shop_id: String((link.config_marketplace_accounts as { shop_id?: string } | null)?.shop_id || "")
      ,moderation_reason: String((link.raw_data as { moderation_reason?: string } | null)?.moderation_reason || "")
      ,parent_listing_id: String(link.marketplace_product_id || "")
      ,variation_id: variationIds.join(", ")
    });
  }
  for (const variation of variations || []) {
    const existing = current.find((item) => item.marketplace_account_id === variation.marketplace_account_id
      && item.external_listing_id === variation.parent_listing_id);
    if (existing) continue;
    const account = variation.config_marketplace_accounts as { name?: string; shop_id?: string } | null;
    current.push({
      id: String(variation.id),
      marketplace: String(variation.marketplace),
      external_listing_id: String(variation.parent_listing_id),
      external_sku: String(variation.sku || ""),
      status: "linked",
      stock: 0,
      price: 0,
      error_message: null,
      last_sync_at: variation.updated_at ? String(variation.updated_at) : null,
      marketplace_name: String(account?.name || ""),
      marketplace_account_id: String(variation.marketplace_account_id),
      marketplace_shop_id: String(account?.shop_id || ""),
      external_url: String(variation.marketplace) === "shopee"
        ? shopeeProductUrl(String(account?.shop_id || ""), String(variation.parent_listing_id))
        : mercadoLivreUrl(String(variation.parent_listing_id)),
      parent_listing_id: String(variation.parent_listing_id),
      variation_id: (variationByListing.get(`${variation.marketplace_account_id}:${variation.parent_listing_id}`) || []).join(", ")
    });
  }
  return { ...product, listings: current };
}

function buildIntegrationRows(product: ProductDetail): IntegrationRow[] {
  const rows: IntegrationRow[] = [];

  if (product.sent_target === "TINY" || product.tiny_product_id) {
    rows.push({
      key: "tiny",
      integration: "TINY",
      name: "Olist Tiny",
      code: product.tiny_product_id || "Vinculo sem codigo",
      sku: product.sku,
      status: product.status,
      sentAt: formatDate(product.sent_at),
      canRemove: true
      ,url: tinyProductUrl(product.tiny_product_id || "")
      ,accountId: ""
      ,parentListingId: ""
      ,variationId: ""
    });
  }

  for (const listing of product.listings || []) {
    if (!listing.external_listing_id) {
      continue;
    }

    const isShopee = String(listing.marketplace || "").toLowerCase() === "shopee";
    rows.push({
      key: listing.id,
      integration: isShopee ? "SHOPEE" : "MERCADO_LIVRE",
      name: listing.marketplace_name || (isShopee ? "Shopee" : "Mercado Livre"),
      code: listing.external_listing_id,
      sku: listing.external_sku || "-",
      status: listing.status,
      sentAt: formatDate(listing.last_sync_at),
      canRemove: true
      ,url: isShopee
        ? shopeeProductUrl(listing.marketplace_shop_id || "", listing.external_listing_id)
        : (listing.external_url || mercadoLivreUrl(listing.external_listing_id))
      ,accountId: listing.marketplace_account_id || ""
      ,parentListingId: listing.parent_listing_id || listing.external_listing_id
      ,variationId: listing.variation_id || ""
      ,moderationReason: listing.moderation_reason || ""
    });
  }

  return rows;
}

function mercadoLivreUrl(itemId: string) {
  const digits = itemId.replace(/^MLB/i, "");
  return `https://produto.mercadolivre.com.br/MLB-${digits}-_JM`;
}

function tinyProductUrl(productId: string) {
  return `https://erp.tiny.com.br/produtos#edit/${encodeURIComponent(productId)}`;
}

function shopeeProductUrl(shopId: string, itemId: string) {
  return shopId
    ? `https://shopee.com.br/product/${encodeURIComponent(shopId)}/${encodeURIComponent(itemId)}`
    : `https://shopee.com.br/search?keyword=${encodeURIComponent(itemId)}`;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function formatRef(row: unknown, key: string) {
  if (!row || typeof row !== "object" || !(key in row)) {
    return "-";
  }

  return String((row as Record<string, unknown>)[key] ?? "-");
}

function formatMeasure(row: unknown, key: string, unit: string) {
  const value = formatRef(row, key);
  if (!value || value === "-") {
    return "-";
  }

  return `${Number(value).toLocaleString("pt-BR")} ${unit}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short"
  });
}

function formatProductStatus(status: string) {
  if (status === "pending_price") {
    return "Aguardando avaliação de preço";
  }
  if (status === "manual_price") {
    return "Aguardando definição manual de preço";
  }
  if (status === "draft") return "Rascunho — aguardando envio";
  if (status === "ready") return "Pronto para envio";

  const labels: Record<string, string> = {
    publishing: "Enviando",
    sent: "Enviado",
    active: "Ativo",
    paused: "Pausado",
    under_review: "Finalizado pelo Mercado Livre",
    error: "Erro"
  };

  return labels[status] || status;
}

function removeSpecialFragments(description: string, configuredRemovals: string) {
  const result = configuredRemovals
    .split(";")
    .map((text) => text.replace(/^\s*(?:<br\s*\/?>\s*)+/i, "").replace(/(?:\s*<br\s*\/?>)+\s*$/i, ""))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .reduce((current, text) => {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return current.replace(new RegExp(escaped, "gi"), "");
    }, description);

  return result.replace(/(?:<br\s*\/?>\s*){2,}/gi, "<br>").trim();
}

