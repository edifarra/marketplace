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

export default async function ProductsPage({ searchParams }: { searchParams?: { q?: string; erro?: string; sucesso?: string } }) {
  noStore();
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
                  <th>Produto / Preco / Est. Fisico</th>
                  <th>Est. Dispon.</th>
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
                      <td><InlineProductEditor product={{ id: product.id, title: product.title, price: Number(product.price || 0), physical: Number(product.estoque_fisico ?? product.stock ?? 0), canEditTitle: !hasProductIntegration(product) }} /></td>
                      <td>{Number(product.estoque_disponivel ?? product.stock ?? 0)}</td>
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
  const supabase = supabaseAdmin();
  let base: Awaited<ReturnType<typeof queryProductsWithSendFields>> | Awaited<ReturnType<typeof queryProductsBaseFields>> =
    await queryProductsWithSendFields(supabase);

  if (base.error && /sent_target|tiny_product_id|schema cache|Could not find/i.test(base.error.message)) {
    base = await queryProductsBaseFields(supabase);
  }

  if (base.error) {
    return { products: [] as ProductRow[], error: base.error.message };
  }

  const products = (base.data ?? []) as ProductRow[];
  const ids = products.map((product) => product.id);
  if (ids.length === 0) {
    return { products, error: "" };
  }

  const [listings, images, inventory] = await Promise.all([
    supabase
      .from("listings")
      .select("id,product_id,marketplace,external_listing_id,status")
      .in("product_id", ids),
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
    error: listings.error?.message || ""
  };
}

function queryProductsWithSendFields(supabase: ReturnType<typeof supabaseAdmin>) {
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

function queryProductsBaseFields(supabase: ReturnType<typeof supabaseAdmin>) {
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
