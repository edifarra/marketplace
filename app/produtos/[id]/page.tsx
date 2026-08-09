import { Sidebar } from "@/app/components/sidebar";
import { sendProductDetailAction } from "../actions";
import { IntegrationDeleteButton } from "./integration-delete-button";
import { buildProductDescription } from "@/lib/dynamic-product-description";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ProductEditor } from "./product-editor";

export const dynamic = "force-dynamic";

const supabase = supabaseAdmin();

type ProductDetail = {
  id: string;
  sku: string;
  source_key: string;
  type_code: string;
  brand_code: string;
  special_code: string | null;
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
  created_at: string;
  product_images: Array<{
    id: string;
    original_name: string;
    url: string | null;
    local_url?: string | null;
    cloudinary_url?: string | null;
    position: number;
    status: string;
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
};

export default async function ProductDetailPage({
  params,
  searchParams
}: {
  params: { id: string };
  searchParams?: { erro?: string; sucesso?: string };
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
  const integrations = buildIntegrationRows(typed);
  const [{ data: type }, { data: brand }, { data: special }, types, brands, specials] = await Promise.all([
    supabase.from("config_types").select("*").eq("code", typed.type_code).maybeSingle(),
    supabase.from("config_brands").select("*").eq("code", typed.brand_code).maybeSingle(),
    typed.special_code
      ? supabase.from("config_specials").select("*").eq("code", typed.special_code).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("config_types").select("code,description").order("description"),
    supabase.from("config_brands").select("code,name").order("name"),
    supabase.from("config_specials").select("code,notes,include_description").order("code")
  ]);
  const description = removeSpecialFragments(
    buildProductDescription(typed, type, brand, special),
    String(special?.remove_description || "")
  );

  const row = typed as unknown as Record<string, unknown>;
  const editable = { ...typed, description,
    width: Number(row.width ?? type?.width ?? 0), height: Number(row.height ?? type?.height ?? 0), length: Number(row.length ?? type?.length ?? 0),
    weight_net: Number(row.weight_net ?? type?.weight_net ?? 0), weight_gross: Number(row.weight_gross ?? type?.weight_gross ?? 0) };

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}

        <ProductEditor product={editable as unknown as Record<string, string | number | null>}
          types={(types.data || []).map(item => ({ code: item.code, label: `${item.code} - ${item.description}` }))}
          brands={(brands.data || []).map(item => ({ code: item.code, label: `${item.code} - ${item.name}` }))}
          specials={(specials.data || []).map(item => ({ code: item.code, label: `${item.code} - ${item.notes || item.include_description || item.code}` }))}
          images={(typed.product_images || []).map(image => ({ id: image.id, name: image.original_name, url: image.cloudinary_url || image.local_url || image.url || "", position: image.position })).filter(image => image.url)} />

        <section className="section card">
          <h2>Envios realizados</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Integracao</th>
                  <th>Vinculacao</th>
                  <th>SKU externo</th>
                  <th>Status</th>
                  <th>Ultimo envio</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {integrations.length === 0 ? (
                  <tr>
                    <td colSpan={6}>Nenhum envio realizado.</td>
                  </tr>
                ) : (
                  integrations.map((integration) => (
                    <tr key={integration.key}>
                      <td>{integration.name}</td>
                      <td><a href={integration.url} target="_blank" rel="noopener noreferrer" className="external-product-link">{integration.code}</a></td>
                      <td>{integration.sku}</td>
                      <td>{formatProductStatus(integration.status)}</td>
                      <td>{integration.sentAt}</td>
                      <td>
                        <div className="row-actions">
                          <form action={sendProductDetailAction}>
                            <input type="hidden" name="productId" value={typed.id} />
                            <button className="secondary compact" type="submit">Reenviar/Atualizar</button>
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

async function getProduct(id: string) {
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
        status
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
        status
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
  const { data } = await supabase
    .from("product_marketplaces")
    .select("id,marketplace,marketplace_product_id,marketplace_account_id,sku,status_anuncio,valor_marketplace,estoque_marketplace,updated_at,raw_data,config_marketplace_accounts(name)")
    .eq("product_id", productId)
    .eq("existe_no_marketplace", true);
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
  for (const link of data || []) {
    const existing = current.find((item) => item.marketplace === link.marketplace && item.external_listing_id === link.marketplace_product_id);
    if (existing) {
      existing.status = String(link.status_anuncio || existing.status || "");
      existing.stock = Number(link.estoque_marketplace || 0);
      existing.price = Number(link.valor_marketplace || existing.price || 0);
      existing.last_sync_at = link.updated_at ? String(link.updated_at) : existing.last_sync_at;
      existing.marketplace_name = String((link.config_marketplace_accounts as { name?: string } | null)?.name || existing.marketplace_name || "");
      existing.marketplace_account_id = String(link.marketplace_account_id || existing.marketplace_account_id || "");
      existing.external_url = String((link.raw_data as { permalink?: string } | null)?.permalink || mercadoLivreUrl(String(link.marketplace_product_id)));
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
      canRemove: !isShopee
      ,url: isShopee ? shopeeProductUrl(listing.external_listing_id) : (listing.external_url || mercadoLivreUrl(listing.external_listing_id))
      ,accountId: listing.marketplace_account_id || ""
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

function shopeeProductUrl(itemId: string) {
  return `https://shopee.com.br/product/0/${encodeURIComponent(itemId)}`;
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
    return "Aguardando Preço";
  }
  if (status === "manual_price") {
    return "Definir Preço Manual";
  }
  if (["draft", "ready"].includes(status)) {
    return "Pendente de Envio";
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

