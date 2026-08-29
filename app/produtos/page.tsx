import Image from "next/image";
import Link from "next/link";
import { Sidebar } from "../components/sidebar";
import { DeleteProductButton } from "./delete-product-button";
import { sendProductAction } from "./actions";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { unstable_noStore as noStore } from "next/cache";
import { InlineProductEditor } from "./inline-product-editor";
import { SynchronizeProductButton } from "./synchronize-product-button";
import { CloneProductButton } from "./clone-product-button";
import { ProductsPosition } from "./products-position";
import { ExternalProductActionSubmit, ProductActionSubmit } from "./product-action-submit";
import { getProductActionState } from "@/lib/product-action-rules";
import { ProductQueueWaiter } from "./product-queue-waiter";
import { CopySkuButton } from "./copy-sku-button";
import { validateRequiredAttributes, type MarketplaceDefinitions, type MarketplaceValues } from "@/lib/marketplace-attributes";
import { validateMarketplaceImage } from "@/lib/marketplace-image-validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ProductRow = {
  id: string;
  sku: string;
  title: string;
  stock: number;
  estoque_fisico?: number;
  estoque_disponivel?: number;
  status: string;
  price: number;
  type_code?: string | null;
  brand_code?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  sent_target?: string | null;
  tiny_product_id?: string | null;
  requiredAttributesComplete?: boolean;
  imagesValid?: boolean;
  listings: {
    id: string;
    marketplace: string;
    marketplace_account_id?: string | null;
    external_listing_id?: string | null;
    status: string;
  }[];
  product_images: {
    original_name: string;
    url: string | null;
    cloudinary_url?: string | null;
    local_url?: string | null;
    position: number;
    bytes?: number | null;
    width_px?: number | null;
    height_px?: number | null;
  }[];
};

const PAGE_SIZE = 100;

type ProductFilters = {
  q: string;
  status: string;
  marketplace: "" | "unlinked" | "tiny_only" | "marketplace_linked";
  brand: string;
  type: string;
  availableStock: "" | "positive" | "zero";
  sort: "recent" | "updated" | "sku" | "name";
};

export default async function ProductsPage({ searchParams }: { searchParams?: { q?: string; page?: string; erro?: string; sucesso?: string; aguardando?: string; fila?: string; status?: string; marketplace?: string; brand?: string; type?: string; availableStock?: string; sort?: string } }) {
  noStore();
  const filters: ProductFilters = {
    q: searchParams?.q?.trim() || "",
    status: searchParams?.status?.trim() || "",
    marketplace: searchParams?.marketplace === "unlinked" || searchParams?.marketplace === "tiny_only" || searchParams?.marketplace === "marketplace_linked" ? searchParams.marketplace : "",
    brand: searchParams?.brand?.trim() || "",
    type: searchParams?.type?.trim() || "",
    availableStock: searchParams?.availableStock === "positive" || searchParams?.availableStock === "zero" ? searchParams.availableStock : "",
    sort: parseSort(searchParams?.sort)
  };
  const requestedPage = Math.max(1, Math.trunc(Number(searchParams?.page || 1)));
  const [{ products, error, total, page, totalPages }, filterOptions, actionConfiguration] = await Promise.all([
    getProducts(requestedPage, filters),
    getProductFilterOptions(),
    getProductActionConfiguration()
  ]);
  const returnTo = `/produtos?${new URLSearchParams({ ...filterParams(filters), page: String(page) }).toString()}`;

  return (
    <main className="shell products-page"><ProductsPosition listKey={returnTo} />
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Produtos e anuncios</h1>
            <div className="subtitle">Produtos cadastrados e status dos anuncios em cada marketplace.</div>
          </div>
          <div className="row-actions">
            <a className="primary link-button" href="/produtos/novo">Novo Produto</a>
          </div>
        </div>

        <section className="card form-card">
          <form action="/produtos" method="get">
            <div className="table-toolbar">
              <div><h2>Filtros e classificacao</h2><div className="muted">Refine a lista e escolha a ordem de exibicao.</div></div>
              <div className="row-actions">
                <button className="secondary" type="submit">Aplicar</button>
                <a className="secondary link-button" href="/produtos">Limpar Filtros</a>
                <label className="products-sort-control">Ordenar por<select name="sort" defaultValue={filters.sort}><option value="recent">Mais recente</option><option value="updated">Data de atualizacao</option><option value="sku">Codigo SKU</option><option value="name">Nome do produto</option></select></label>
              </div>
            </div>
            <div className="form-grid">
              <label>Buscar<input name="q" placeholder="SKU ou titulo" defaultValue={filters.q} /></label>
              <label>Status<select name="status" defaultValue={filters.status}><option value="">Todos</option>{filterOptions.statuses.map(status => <option value={status} key={status}>{formatProductStatus(status)}</option>)}</select></label>
              <label>Marketplaces<select name="marketplace" defaultValue={filters.marketplace}><option value="">Todos</option><option value="unlinked">Sem vinculo</option><option value="tiny_only">Com vinculo apenas no Tiny</option><option value="marketplace_linked">Com vinculo em Marketplaces</option></select></label>
              <label>Marca<select name="brand" defaultValue={filters.brand}><option value="">Todas</option>{filterOptions.brands.map(item => <option value={item.code} key={item.code}>{item.name || item.code}</option>)}</select></label>
              <label>Tipo de Produto<select name="type" defaultValue={filters.type}><option value="">Todos</option>{filterOptions.types.map(item => <option value={item.code} key={item.code}>{item.description || item.code}</option>)}</select></label>
              <label>Estoque Disponível<select name="availableStock" defaultValue={filters.availableStock}><option value="">Todos</option><option value="positive">Maior que Zero</option><option value="zero">Zerado</option></select></label>
            </div>
          </form>
        </section>

        <section className="card">
          {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
          {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
          {searchParams?.fila && <ProductQueueWaiter activityIds={searchParams.fila.split(",").filter(Boolean)} returnTo={returnTo} initialMessage={searchParams.aguardando || "Envio registrado. Aguardando execução da fila..."} />}
          {error && <div className="form-error">Erro ao carregar produtos: {error}</div>}
          <div className="table-toolbar">
            <div>
              <h2>Produtos</h2>
              <div className="muted">{total} produto(s) encontrado(s)</div>
            </div>
          </div>
          <ProductPagination page={page} totalPages={totalPages} total={total} filters={filters} />

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Produto</th>
                  <th>Preco</th>
                  <th>Est. Fisico</th>
                  <th>Est. Dispon.</th>
                  <th>Status</th>
                  <th>MarketPlaces</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={8}>Nenhum produto encontrado.</td>
                  </tr>
                ) : (
                  products.map((product) => {
                    const actions = productActions(product, actionConfiguration);
                    const requiredAttributesReason = !product.imagesValid ? "Corrigir fotos fora do padrão" : product.requiredAttributesComplete ? undefined : "Preencher atributos obrigatórios";
                    return (
                    <tr key={product.id}>
                      <td>
                        <div className="sku-with-thumb">
                          <ProductThumb product={product} />
                          <span className="sku-value">
                            <Link href={`/produtos/${product.id}?returnTo=${encodeURIComponent(returnTo)}`}>{product.sku}</Link>
                            <CopySkuButton sku={product.sku} />
                          </span>
                        </div>
                      </td>
                      <InlineProductEditor returnTo={returnTo} product={{ id: product.id, title: product.title, price: Number(product.price || 0), physical: Number(product.estoque_fisico ?? product.stock ?? 0), available: Number(product.estoque_disponivel ?? product.stock ?? 0), canEditTitle: true }} />
                      <td>{formatProductStatus(product.status)}</td>
                      <td>
                        <MarketplaceLogos product={product} />
                      </td>
                      <td>
                        <div className="row-actions">
                          {actions.showSave && <ExternalProductActionSubmit label="Salvar" form={`product-edit-${product.id}`} disabledReason={requiredAttributesReason} />}
                          {actions.showSend && actions.saveBeforeSend && <ExternalProductActionSubmit label="Enviar" pendingLabel="Salvando e enviando" form={`product-edit-${product.id}`} name="intent" value="send" requireAvailableStock disabledReason={requiredAttributesReason} />}
                          {actions.showSend && !actions.saveBeforeSend && <form action={sendProductAction}>
                            <input type="hidden" name="productId" value={product.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <ProductActionSubmit label="Enviar" pendingLabel="Enviando" disabledReason={requiredAttributesReason} />
                          </form>}
                          <SynchronizeProductButton productId={product.id} returnTo={returnTo} />
                          <CloneProductButton productId={product.id} returnTo={returnTo} />
                          <DeleteProductButton productId={product.id} returnTo={returnTo} />
                        </div>
                      </td>
                    </tr>
                  )})
                )}
              </tbody>
            </table>
          </div>
          <ProductPagination page={page} totalPages={totalPages} total={total} filters={filters} />
        </section>
      </section>
    </main>
  );
}

async function getProducts(requestedPage: number, filters: ProductFilters) {
  const supabase = supabaseAdmin();
  const countQuery = applyProductFilters(supabase.from("products_with_link_type").select("id", { count: "exact", head: true }), filters);
  const countResult = await countQuery;
  const total = Number(countResult.count || 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  let base: Awaited<ReturnType<typeof queryProductsWithSendFields>> | Awaited<ReturnType<typeof queryProductsBaseFields>> =
    await queryProductsWithSendFields(supabase, from, to, filters);

  if (base.error && /sent_target|tiny_product_id|schema cache|Could not find/i.test(base.error.message)) {
    base = await queryProductsBaseFields(supabase, from, to, filters);
  }

  if (base.error) {
    return { products: [] as ProductRow[], error: base.error.message, total, page, totalPages };
  }

  const products = (base.data ?? []) as ProductRow[];
  const ids = products.map((product) => product.id);
  if (ids.length === 0) {
    return { products, error: "", total, page, totalPages };
  }

  const [listings, marketplaceLinks, images, inventory, validationProducts, types, mappings] = await Promise.all([
    supabase
      .from("listings")
      .select("id,product_id,marketplace,marketplace_account_id,external_listing_id,status")
      .in("product_id", ids),
    supabase.from("product_marketplaces").select("id,product_id,marketplace,marketplace_account_id,marketplace_product_id,status_anuncio").in("product_id", ids).eq("existe_no_marketplace", true),
    getProductImages(supabase, ids),
    supabase.from("estoque").select("product_id,estoque_fisico,estoque_disponivel").in("product_id", ids),
    supabase.from("products").select("id,sku,title,description,price,type_code,brand_code,model,board_code,width,height,length,weight_net,weight_gross,marketplace_attributes").in("id", ids),
    supabase.from("config_types").select("code,marketplace_category,marketplace_active_attributes"),
    supabase.from("marketplace_category_mappings").select("internal_category,attribute_definitions")
  ]);

  const listingsByProduct = new Map<string, ProductRow["listings"]>();
  for (const listing of listings.data ?? []) {
    const productId = String((listing as { product_id: string }).product_id);
    const current = listingsByProduct.get(productId) || [];
    current.push(listing as ProductRow["listings"][number]);
    listingsByProduct.set(productId, current);
  }
  for (const link of marketplaceLinks.data ?? []) {
    const productId = String(link.product_id);
    const current = listingsByProduct.get(productId) || [];
    if (!current.some((item) => item.marketplace === link.marketplace && item.external_listing_id === link.marketplace_product_id)) {
      current.push({ id: String(link.id), marketplace: String(link.marketplace), marketplace_account_id: String(link.marketplace_account_id), external_listing_id: String(link.marketplace_product_id), status: String(link.status_anuncio || "") });
    }
    listingsByProduct.set(productId, current);
  }

  const imagesByProduct = new Map<string, ProductRow["product_images"]>();
  for (const image of images) {
    const productId = String((image as { product_id: string }).product_id);
    const current = imagesByProduct.get(productId) || [];
    current.push(image as ProductRow["product_images"][number]);
    imagesByProduct.set(productId, current);
  }
  const inventoryByProduct = new Map((inventory.data || []).map(row => [String(row.product_id), row]));
  const validationByProduct = new Map((validationProducts.data || []).map(row => [String(row.id), row]));
  const typeByCode = new Map((types.data || []).map(row => [String(row.code), row]));
  const mappingByCategory = new Map((mappings.data || []).map(row => [String(row.internal_category), row]));

  return {
    products: products.map((product) => ({
      ...product,
      estoque_fisico: Number(inventoryByProduct.get(product.id)?.estoque_fisico ?? product.stock ?? 0),
      estoque_disponivel: Number(inventoryByProduct.get(product.id)?.estoque_disponivel ?? product.stock ?? 0),
      requiredAttributesComplete: hasRequiredProductAttributes(validationByProduct.get(product.id), typeByCode, mappingByCategory, imagesByProduct.get(product.id) || []),
      imagesValid: (imagesByProduct.get(product.id) || []).length > 0 && (imagesByProduct.get(product.id) || []).every(image => validateMarketplaceImage({ width: Number(image.width_px), height: Number(image.height_px), bytes: Number(image.bytes) }).length === 0),
      listings: listingsByProduct.get(product.id) || [],
      product_images: imagesByProduct.get(product.id) || []
    })),
    error: listings.error?.message || marketplaceLinks.error?.message || countResult.error?.message || "",
    total, page, totalPages
  };
}

function hasRequiredProductAttributes(
  product: Record<string, any> | undefined,
  typeByCode: Map<string, Record<string, any>>,
  mappingByCategory: Map<string, Record<string, any>>,
  images: ProductRow["product_images"]
) {
  if (!product) return false;
  const typeCode = String(product.type_code || "");
  const type = typeByCode.get(typeCode);
  const mapping = mappingByCategory.get(String(type?.marketplace_category || ""));
  const definitions = (mapping?.attribute_definitions || {}) as MarketplaceDefinitions;
  const active = type?.marketplace_active_attributes as Partial<Record<"mercado_livre" | "shopee", string[]>> | null;
  const activeDefinitions = active == null ? definitions : Object.fromEntries(
    (["mercado_livre", "shopee"] as const).map(marketplace => [marketplace, definitions[marketplace] ? {
      ...definitions[marketplace],
      attributes: active[marketplace] === undefined
        ? definitions[marketplace]!.attributes
        : Object.fromEntries(Object.entries(definitions[marketplace]!.attributes || {}).filter(([id]) => active[marketplace]!.includes(id)))
    } : undefined])
  ) as MarketplaceDefinitions;
  const boardCodeRequired = (["mercado_livre", "shopee"] as const).some(marketplace =>
    Object.values(activeDefinitions[marketplace]?.attributes || {}).some(attribute => attribute.systemSource === "board_code" && attribute.required)
  );
  const validNumber = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0;
  return Boolean(
    String(product.sku || "").trim()
    && String(product.title || "").trim().length > 0
    && String(product.title || "").trim().length <= 60
    && typeCode && typeCode !== "OT"
    && String(product.brand_code || "") && String(product.brand_code) !== "NI"
    && String(product.model || "").trim().length >= 2
    && (!boardCodeRequired || String(product.board_code || "").trim().length >= 2)
    && [product.price, product.width, product.height, product.length, product.weight_net, product.weight_gross].every(validNumber)
    && images.length > 0
    && validateRequiredAttributes(activeDefinitions, (product.marketplace_attributes || {}) as MarketplaceValues).length === 0
  );
}

function queryProductsWithSendFields(supabase: ReturnType<typeof supabaseAdmin>, from: number, to: number, filters: ProductFilters) {
  let query = supabase
    .from("products_with_link_type")
    .select(`
      id,
      sku,
      title,
      stock,
      status,
      price,
      type_code,
      brand_code,
      created_at,
      updated_at,
      sent_target,
      tiny_product_id
    `);
  query = applyProductFilters(query, filters);
  return applyProductOrder(query, filters.sort).range(from, to);
}

function queryProductsBaseFields(supabase: ReturnType<typeof supabaseAdmin>, from: number, to: number, filters: ProductFilters) {
  let query = supabase
    .from("products_with_link_type")
    .select(`
      id,
      sku,
      title,
      stock,
      status,
      price,
      type_code,
      brand_code,
      created_at,
      updated_at
    `);
  query = applyProductFilters(query, filters);
  return applyProductOrder(query, filters.sort).range(from, to);
}

async function getProductImages(supabase: ReturnType<typeof supabaseAdmin>, productIds: string[]) {
  const withLocal = await supabase
    .from("product_images")
    .select("product_id,original_name,url,cloudinary_url,local_url,position,bytes,width_px,height_px")
    .in("product_id", productIds);

  if (!withLocal.error) {
    return withLocal.data ?? [];
  }

  const fallback = await supabase
    .from("product_images")
    .select("product_id,original_name,url,position,bytes,width_px,height_px")
    .in("product_id", productIds);

  return fallback.data ?? [];
}

function ProductThumb({ product }: { product: ProductRow }) {
  const image = [...(product.product_images || [])].sort((a, b) => a.position - b.position)[0];
  const src = image?.cloudinary_url || image?.url || image?.local_url;

  if (!src) {
    return <span className="product-thumb-placeholder">01</span>;
  }

  return (
    <Image
      className="product-thumb"
      src={src}
      alt={image.original_name}
      width={42}
      height={42}
      unoptimized
    />
  );
}

function MarketplaceLogos({ product }: { product: ProductRow }) {
  const tinySent = product.sent_target === "TINY" || Boolean(product.tiny_product_id);
  const published = (product.listings || []).filter((listing) => listing.external_listing_id);
  if (!tinySent && published.length === 0) {
    return <span className="muted">Aguardando envio</span>;
  }

  return (
    <div className="marketplace-logos">
      {tinySent && <span className="marketplace-logo olist-tiny" title="Produto enviado ao Olist Tiny">OlistTiny</span>}
      {published.map((listing) => (
        <Image
          className="marketplace-mini-logo"
          src={listing.marketplace === "shopee" ? "/marketplaces/shopee-mini.webp" : "/marketplaces/mercado-livre-mini.png"}
          width={25}
          height={25}
          alt={listing.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}
          title={`${listing.marketplace}: ${listing.external_listing_id}`}
          key={listing.id}
        />
      ))}
    </div>
  );
}

function ProductPagination({ page, totalPages, total, filters }: { page: number; totalPages: number; total: number; filters: ProductFilters }) {
  const start = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(page * PAGE_SIZE, total);
  const href = (target: number) => `/produtos?${new URLSearchParams({ ...filterParams(filters), page: String(target) }).toString()}`;
  return <nav className="product-pagination" aria-label="Navegacao de produtos">
    <Link className={`secondary link-button compact ${page <= 1 ? "disabled" : ""}`} href={href(1)} aria-disabled={page <= 1}>Primeira</Link>
    <Link className={`secondary link-button compact ${page <= 1 ? "disabled" : ""}`} href={href(Math.max(1, page - 1))} aria-disabled={page <= 1}>Anterior</Link>
    <span>{start}–{end} produtos de {total}</span>
    <Link className={`secondary link-button compact ${page >= totalPages ? "disabled" : ""}`} href={href(Math.min(totalPages, page + 1))} aria-disabled={page >= totalPages}>Proxima</Link>
    <Link className={`secondary link-button compact ${page >= totalPages ? "disabled" : ""}`} href={href(totalPages)} aria-disabled={page >= totalPages}>Ultima</Link>
  </nav>;
}

function escapeSearch(value: string) { return value.replace(/[%(),]/g, ""); }

function parseSort(value: string | undefined): ProductFilters["sort"] {
  return value === "updated" || value === "sku" || value === "name" ? value : "recent";
}

function filterParams(filters: ProductFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
}

function applyProductFilters<T extends { or: Function; eq: Function; gt: Function }>(query: T, filters: ProductFilters): T {
  let result: any = query;
  if (filters.q) result = result.or(`sku.ilike.%${escapeSearch(filters.q)}%,title.ilike.%${escapeSearch(filters.q)}%`);
  if (filters.status) result = result.eq("status", filters.status);
  if (filters.brand) result = result.eq("brand_code", filters.brand);
  if (filters.type) result = result.eq("type_code", filters.type);
  if (filters.marketplace) result = result.eq("integration_link_type", filters.marketplace);
  if (filters.availableStock === "positive") result = result.gt("estoque_disponivel", 0);
  if (filters.availableStock === "zero") result = result.eq("estoque_disponivel", 0);
  return result as T;
}

function applyProductOrder<T extends { order: Function }>(query: T, sort: ProductFilters["sort"]): T {
  const order = sort === "updated" ? { column: "updated_at", ascending: false } : sort === "sku" ? { column: "sku", ascending: true } : sort === "name" ? { column: "title", ascending: true } : { column: "created_at", ascending: false };
  return query.order(order.column, { ascending: order.ascending }) as T;
}

async function getProductFilterOptions() {
  const db = supabaseAdmin();
  const [enumStatuses, currentStatuses, brands, types] = await Promise.all([
    db.rpc("list_product_statuses"),
    db.from("products").select("status").order("status"),
    db.from("config_brands").select("code,name").order("name"),
    db.from("config_types").select("code,description").order("description")
  ]);
  const statuses: string[] = enumStatuses.error
    ? (currentStatuses.data || []).map(row => String(row.status))
    : ((enumStatuses.data || []) as Array<{ status: string }>).map(row => String(row.status));
  return {
    statuses: [...new Set(statuses.filter(Boolean))],
    brands: (brands.data || []) as Array<{ code: string; name: string }>,
    types: (types.data || []) as Array<{ code: string; description: string }>
  };
}

function hasProductIntegration(product: ProductRow) {
  return Boolean(product.tiny_product_id || (product.listings || []).some((listing) => listing.external_listing_id));
}

type ProductActionConfiguration = { mode: "TINY" | "MARKETPLACE_DIRETO"; activeAccountIds: string[] };

async function getProductActionConfiguration(): Promise<ProductActionConfiguration> {
  const db = supabaseAdmin();
  const [setting, accounts] = await Promise.all([
    db.from("settings").select("value").eq("key", "PRODUCT_SEND_TARGET").maybeSingle(),
    db.from("config_marketplace_accounts").select("id").in("marketplace", ["mercado_livre", "shopee"]).eq("active", true)
  ]);
  return {
    mode: String(setting.data?.value || "TINY") === "MARKETPLACE_DIRETO" ? "MARKETPLACE_DIRETO" : "TINY",
    activeAccountIds: (accounts.data || []).map(account => String(account.id))
  };
}

function productActions(product: ProductRow, configuration: ProductActionConfiguration) {
  return getProductActionState(configuration.mode, configuration.activeAccountIds, {
    tinyProductId: product.tiny_product_id,
    marketplaceLinks: (product.listings || []).map(listing => ({ accountId: listing.marketplace_account_id, externalId: listing.external_listing_id }))
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
    error: "Erro"
  };

  return labels[status] || status;
}
