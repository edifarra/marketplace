import Image from "next/image";
import Link from "next/link";
import { Sidebar } from "../components/sidebar";
import { DeleteProductButton } from "./delete-product-button";
import { sendProductAction } from "./actions";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { unstable_noStore as noStore } from "next/cache";
import { InlineProductEditor } from "./inline-product-editor";

export const dynamic = "force-dynamic";

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
  listings: {
    id: string;
    marketplace: string;
    external_listing_id?: string | null;
    status: string;
  }[];
  product_images: {
    original_name: string;
    url: string | null;
    cloudinary_url?: string | null;
    local_url?: string | null;
    position: number;
  }[];
};

const PAGE_SIZE = 100;

type ProductFilters = {
  q: string;
  status: string;
  marketplace: "" | "linked" | "unlinked";
  brand: string;
  type: string;
  sort: "recent" | "updated" | "sku" | "name";
};

export default async function ProductsPage({ searchParams }: { searchParams?: { q?: string; page?: string; erro?: string; sucesso?: string; status?: string; marketplace?: string; brand?: string; type?: string; sort?: string } }) {
  noStore();
  const filters: ProductFilters = {
    q: searchParams?.q?.trim() || "",
    status: searchParams?.status?.trim() || "",
    marketplace: searchParams?.marketplace === "linked" || searchParams?.marketplace === "unlinked" ? searchParams.marketplace : "",
    brand: searchParams?.brand?.trim() || "",
    type: searchParams?.type?.trim() || "",
    sort: parseSort(searchParams?.sort)
  };
  const requestedPage = Math.max(1, Math.trunc(Number(searchParams?.page || 1)));
  const [{ products, error, total, page, totalPages }, filterOptions] = await Promise.all([
    getProducts(requestedPage, filters),
    getProductFilterOptions()
  ]);

  return (
    <main className="shell">
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
              </div>
            </div>
            <div className="form-grid">
              <label>Buscar<input name="q" placeholder="SKU ou titulo" defaultValue={filters.q} /></label>
              <label>Status<select name="status" defaultValue={filters.status}><option value="">Todos</option>{filterOptions.statuses.map(status => <option value={status} key={status}>{formatProductStatus(status)}</option>)}</select></label>
              <label>Marketplaces<select name="marketplace" defaultValue={filters.marketplace}><option value="">Todos</option><option value="linked">Com vinculo</option><option value="unlinked">Sem vinculo</option></select></label>
              <label>Marca<select name="brand" defaultValue={filters.brand}><option value="">Todas</option>{filterOptions.brands.map(item => <option value={item.code} key={item.code}>{item.name || item.code}</option>)}</select></label>
              <label>Tipo de Produto<select name="type" defaultValue={filters.type}><option value="">Todos</option>{filterOptions.types.map(item => <option value={item.code} key={item.code}>{item.name || item.code}</option>)}</select></label>
              <label>Ordenar por<select name="sort" defaultValue={filters.sort}><option value="recent">Mais recente</option><option value="updated">Data de atualizacao</option><option value="sku">Codigo SKU</option><option value="name">Nome do produto</option></select></label>
            </div>
          </form>
        </section>

        <section className="card">
          {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
          {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
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
                  products.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <div className="sku-with-thumb">
                          <ProductThumb product={product} />
                          <Link href={`/produtos/${product.id}`}>{product.sku}</Link>
                        </div>
                      </td>
                      <InlineProductEditor product={{ id: product.id, title: product.title, price: Number(product.price || 0), physical: Number(product.estoque_fisico ?? product.stock ?? 0), available: Number(product.estoque_disponivel ?? product.stock ?? 0), canEditTitle: !hasProductIntegration(product) }} />
                      <td>{formatProductStatus(product.status)}</td>
                      <td>
                        <MarketplaceLogos product={product} />
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="secondary compact" type="submit" form={`product-edit-${product.id}`}>Salvar</button>
                          <form action={sendProductAction}>
                            <input type="hidden" name="productId" value={product.id} />
                            <button className="secondary compact" type="submit">{hasProductIntegration(product) ? "Atualizar" : "Enviar"}</button>
                          </form>
                          <DeleteProductButton productId={product.id} />
                        </div>
                      </td>
                    </tr>
                  ))
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
  const linkedIds = filters.marketplace ? await getLinkedProductIds(supabase) : [];
  const countQuery = applyProductFilters(supabase.from("products").select("id", { count: "exact", head: true }), filters, linkedIds);
  const countResult = await countQuery;
  const total = Number(countResult.count || 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  let base: Awaited<ReturnType<typeof queryProductsWithSendFields>> | Awaited<ReturnType<typeof queryProductsBaseFields>> =
    await queryProductsWithSendFields(supabase, from, to, filters, linkedIds);

  if (base.error && /sent_target|tiny_product_id|schema cache|Could not find/i.test(base.error.message)) {
    base = await queryProductsBaseFields(supabase, from, to, filters, linkedIds);
  }

  if (base.error) {
    return { products: [] as ProductRow[], error: base.error.message, total, page, totalPages };
  }

  const products = (base.data ?? []) as ProductRow[];
  const ids = products.map((product) => product.id);
  if (ids.length === 0) {
    return { products, error: "", total, page, totalPages };
  }

  const [listings, marketplaceLinks, images, inventory] = await Promise.all([
    supabase
      .from("listings")
      .select("id,product_id,marketplace,external_listing_id,status")
      .in("product_id", ids),
    supabase.from("product_marketplaces").select("id,product_id,marketplace,marketplace_product_id,status_anuncio").in("product_id", ids).eq("existe_no_marketplace", true),
    getProductImages(supabase, ids),
    supabase.from("estoque").select("product_id,estoque_fisico,estoque_disponivel").in("product_id", ids)
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
      current.push({ id: String(link.id), marketplace: String(link.marketplace), external_listing_id: String(link.marketplace_product_id), status: String(link.status_anuncio || "") });
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

  return {
    products: products.map((product) => ({
      ...product,
      estoque_fisico: Number(inventoryByProduct.get(product.id)?.estoque_fisico ?? product.stock ?? 0),
      estoque_disponivel: Number(inventoryByProduct.get(product.id)?.estoque_disponivel ?? product.stock ?? 0),
      listings: listingsByProduct.get(product.id) || [],
      product_images: imagesByProduct.get(product.id) || []
    })),
    error: listings.error?.message || marketplaceLinks.error?.message || countResult.error?.message || "",
    total, page, totalPages
  };
}

function queryProductsWithSendFields(supabase: ReturnType<typeof supabaseAdmin>, from: number, to: number, filters: ProductFilters, linkedIds: string[]) {
  let query = supabase
    .from("products")
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
  query = applyProductFilters(query, filters, linkedIds);
  return applyProductOrder(query, filters.sort).range(from, to);
}

function queryProductsBaseFields(supabase: ReturnType<typeof supabaseAdmin>, from: number, to: number, filters: ProductFilters, linkedIds: string[]) {
  let query = supabase
    .from("products")
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
  query = applyProductFilters(query, filters, linkedIds);
  return applyProductOrder(query, filters.sort).range(from, to);
}

async function getProductImages(supabase: ReturnType<typeof supabaseAdmin>, productIds: string[]) {
  const withLocal = await supabase
    .from("product_images")
    .select("product_id,original_name,url,cloudinary_url,local_url,position")
    .in("product_id", productIds);

  if (!withLocal.error) {
    return withLocal.data ?? [];
  }

  const fallback = await supabase
    .from("product_images")
    .select("product_id,original_name,url,position")
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
  const tinySent = product.sent_target === "TINY" || Boolean(product.tiny_product_id) || product.status === "sent";
  const published = (product.listings || []).filter((listing) => listing.external_listing_id);
  if (!tinySent && published.length === 0) {
    return <span className="muted">Aguardando envio</span>;
  }

  return (
    <div className="marketplace-logos">
      {tinySent && <span className="marketplace-logo olist-tiny" title="Produto enviado ao Olist Tiny">OlistTiny</span>}
      {published.map((listing) => (
        <span
          className={`marketplace-logo ${listing.marketplace === "shopee" ? "shopee" : "mercado-livre"}`}
          title={`${listing.marketplace}: ${listing.external_listing_id}`}
          key={listing.id}
        >
          {listing.marketplace === "shopee" ? "Shopee" : "ML"}
        </span>
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

function applyProductFilters<T extends { or: Function; eq: Function; in: Function; not: Function }>(query: T, filters: ProductFilters, linkedIds: string[]): T {
  let result: any = query;
  if (filters.q) result = result.or(`sku.ilike.%${escapeSearch(filters.q)}%,title.ilike.%${escapeSearch(filters.q)}%`);
  if (filters.status) result = result.eq("status", filters.status);
  if (filters.brand) result = result.eq("brand_code", filters.brand);
  if (filters.type) result = result.eq("type_code", filters.type);
  if (filters.marketplace === "linked") result = linkedIds.length ? result.in("id", linkedIds) : result.in("id", ["00000000-0000-0000-0000-000000000000"]);
  if (filters.marketplace === "unlinked" && linkedIds.length) result = result.not("id", "in", `(${linkedIds.join(",")})`);
  return result as T;
}

function applyProductOrder<T extends { order: Function }>(query: T, sort: ProductFilters["sort"]): T {
  const order = sort === "updated" ? { column: "updated_at", ascending: false } : sort === "sku" ? { column: "sku", ascending: true } : sort === "name" ? { column: "title", ascending: true } : { column: "created_at", ascending: false };
  return query.order(order.column, { ascending: order.ascending }) as T;
}

async function getLinkedProductIds(supabase: ReturnType<typeof supabaseAdmin>) {
  const [listings, links, tiny] = await Promise.all([
    supabase.from("listings").select("product_id").not("external_listing_id", "is", null),
    supabase.from("product_marketplaces").select("product_id").eq("existe_no_marketplace", true).not("product_id", "is", null),
    supabase.from("products").select("id").or("tiny_product_id.not.is.null,sent_target.eq.TINY")
  ]);
  return [...new Set([...(listings.data || []).map(row => String(row.product_id)), ...(links.data || []).map(row => String(row.product_id)), ...(tiny.data || []).map(row => String(row.id))].filter(Boolean))];
}

async function getProductFilterOptions() {
  const db = supabaseAdmin();
  const [statuses, brands, types] = await Promise.all([
    db.from("products").select("status").order("status"),
    db.from("config_brands").select("code,name").order("name"),
    db.from("config_types").select("code,name").order("name")
  ]);
  return {
    statuses: [...new Set((statuses.data || []).map(row => String(row.status)).filter(Boolean))],
    brands: (brands.data || []) as Array<{ code: string; name: string }>,
    types: (types.data || []) as Array<{ code: string; name: string }>
  };
}

function hasProductIntegration(product: ProductRow) {
  return Boolean(product.tiny_product_id || product.sent_target === "TINY" || (product.listings || []).some((listing) => listing.external_listing_id));
}

function formatProductStatus(status: string) {
  if (["draft", "ready"].includes(status)) {
    return "A Enviar";
  }

  const labels: Record<string, string> = {
    publishing: "Enviando",
    sent: "Enviado",
    active: "Ativo",
    paused: "Pausado",
    error: "Erro"
  };

  return labels[status] || status;
}
