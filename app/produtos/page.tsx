import { createClient } from "@supabase/supabase-js";
import Image from "next/image";
import Link from "next/link";
import { Sidebar } from "../components/sidebar";
import { DeleteProductButton } from "./delete-product-button";
import { sendProductAction } from "./actions";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type ProductRow = {
  id: string;
  sku: string;
  title: string;
  stock: number;
  status: string;
  price: number;
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
    local_url?: string | null;
    position: number;
  }[];
};

export default async function ProductsPage({ searchParams }: { searchParams?: { q?: string; erro?: string; sucesso?: string } }) {
  const query = searchParams?.q?.trim() || "";
  const { products: data, error } = await getProducts();

  const products = ((data ?? []) as ProductRow[]).filter((product) => {
    if (!query) return true;
    const haystack = `${product.sku} ${product.title}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Produtos e anuncios</h1>
            <div className="subtitle">Produtos cadastrados e status dos anuncios em cada marketplace.</div>
          </div>
          <a className="primary link-button" href="/produtos/novo">Novo Produto</a>
        </div>

        <section className="card">
          {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
          {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
          {error && <div className="form-error">Erro ao carregar produtos: {error}</div>}
          <div className="table-toolbar">
            <div>
              <h2>Produtos</h2>
              <div className="muted">{products.length} produto(s) encontrado(s)</div>
            </div>
            <form className="search-form" action="/produtos">
              <input name="q" placeholder="Buscar por SKU ou titulo" defaultValue={query} />
              <button className="secondary" type="submit">Buscar</button>
            </form>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Produto</th>
                  <th>Preco</th>
                  <th>Estoque</th>
                  <th>Status</th>
                  <th>MarketPlaces</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={7}>Nenhum produto encontrado.</td>
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
                      <td>{product.title}</td>
                      <td>{Number(product.price || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td>
                      <td>{product.stock}</td>
                      <td>{formatProductStatus(product.status)}</td>
                      <td>
                        <MarketplaceLogos product={product} />
                      </td>
                      <td>
                        <div className="row-actions">
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
        </section>
      </section>
    </main>
  );
}

async function getProducts() {
  let base: Awaited<ReturnType<typeof queryProductsWithSendFields>> | Awaited<ReturnType<typeof queryProductsBaseFields>> =
    await queryProductsWithSendFields();

  if (base.error && /sent_target|tiny_product_id|schema cache|Could not find/i.test(base.error.message)) {
    base = await queryProductsBaseFields();
  }

  if (base.error) {
    return { products: [] as ProductRow[], error: base.error.message };
  }

  const products = (base.data ?? []) as ProductRow[];
  const ids = products.map((product) => product.id);
  if (ids.length === 0) {
    return { products, error: "" };
  }

  const [listings, images] = await Promise.all([
    supabase
      .from("listings")
      .select("id,product_id,marketplace,external_listing_id,status")
      .in("product_id", ids),
    getProductImages(ids)
  ]);

  const listingsByProduct = new Map<string, ProductRow["listings"]>();
  for (const listing of listings.data ?? []) {
    const productId = String((listing as { product_id: string }).product_id);
    const current = listingsByProduct.get(productId) || [];
    current.push(listing as ProductRow["listings"][number]);
    listingsByProduct.set(productId, current);
  }

  const imagesByProduct = new Map<string, ProductRow["product_images"]>();
  for (const image of images) {
    const productId = String((image as { product_id: string }).product_id);
    const current = imagesByProduct.get(productId) || [];
    current.push(image as ProductRow["product_images"][number]);
    imagesByProduct.set(productId, current);
  }

  return {
    products: products.map((product) => ({
      ...product,
      listings: listingsByProduct.get(product.id) || [],
      product_images: imagesByProduct.get(product.id) || []
    })),
    error: listings.error?.message || ""
  };
}

function queryProductsWithSendFields() {
  return supabase
    .from("products")
    .select(`
      id,
      sku,
      title,
      stock,
      status,
      price,
      sent_target,
      tiny_product_id
    `)
    .order("created_at", { ascending: false });
}

function queryProductsBaseFields() {
  return supabase
    .from("products")
    .select(`
      id,
      sku,
      title,
      stock,
      status,
      price
    `)
    .order("created_at", { ascending: false });
}

async function getProductImages(productIds: string[]) {
  const withLocal = await supabase
    .from("product_images")
    .select("product_id,original_name,url,local_url,position")
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
  const src = image?.local_url || image?.url;

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
  if (tinySent) {
    return <span className="marketplace-logo olist-tiny" title="Produto enviado ao Olist Tiny">OlistTiny</span>;
  }

  const published = (product.listings || []).filter((listing) => listing.external_listing_id);
  if (published.length === 0) {
    return <span className="muted">Aguardando envio</span>;
  }

  return (
    <div className="marketplace-logos">
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
