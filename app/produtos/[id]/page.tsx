import { createClient } from "@supabase/supabase-js";
import Image from "next/image";
import { Sidebar } from "@/app/components/sidebar";
import { sendProductDetailAction } from "../actions";
import { IntegrationDeleteButton } from "./integration-delete-button";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
  description: string;
  price: number;
  stock: number;
  status: string;
  sent_target?: string | null;
  sent_at?: string | null;
  tiny_product_id?: string | null;
  created_at: string;
  product_images: Array<{
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
  const hasIntegration = integrations.length > 0;
  const [{ data: type }, { data: brand }, { data: special }] = await Promise.all([
    supabase.from("config_types").select("*").eq("code", typed.type_code).maybeSingle(),
    supabase.from("config_brands").select("*").eq("code", typed.brand_code).maybeSingle(),
    typed.special_code
      ? supabase.from("config_specials").select("*").eq("code", typed.special_code).maybeSingle()
      : Promise.resolve({ data: null })
  ]);

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>{typed.sku}</h1>
            <div className="subtitle">{typed.title}</div>
          </div>
          <div className="row-actions">
            <form action={sendProductDetailAction}>
              <input type="hidden" name="productId" value={typed.id} />
              <button className="primary" type="submit">{hasIntegration ? "Atualizar" : "Enviar"}</button>
            </form>
            <a className="secondary" href="/produtos">Voltar</a>
          </div>
        </div>

        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}

        <section className="grid detail-grid">
          <div className="card">
            <h2>Produto</h2>
            <Info label="SKU" value={typed.sku} />
            <Info label="Status" value={formatProductStatus(typed.status)} />
            <Info label="Estoque" value={String(typed.stock)} />
            <Info label="Preco" value={Number(typed.price || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} />
            <Info label="Modelo" value={typed.model || "-"} />
            <Info label="Codigo da placa" value={typed.board_code || "-"} />
            <Info label="Versao" value={typed.version || "-"} />
            <Info label="Origem" value={typed.source_key} />
          </div>

          <div className="card">
            <h2>Referencias</h2>
            <Info label="Tipo" value={`${typed.type_code} - ${formatRef(type, "description")}`} />
            <Info label="Marca" value={`${typed.brand_code} - ${formatRef(brand, "name")}`} />
            <Info label="Especial" value={typed.special_code ? `${typed.special_code} - ${formatRef(special, "notes")}` : "-"} />
            <Info label="Grupo SKU" value={formatRef(type, "sku_group")} />
            <Info label="Categoria" value={formatRef(type, "marketplace_category")} />
            <Info label="Largura" value={formatMeasure(type, "width", "cm")} />
            <Info label="Altura" value={formatMeasure(type, "height", "cm")} />
            <Info label="Comprimento" value={formatMeasure(type, "length", "cm")} />
            <Info label="Peso liquido" value={formatMeasure(type, "weight_net", "kg")} />
            <Info label="Peso bruto" value={formatMeasure(type, "weight_gross", "kg")} />
          </div>
        </section>

        <section className="section card">
          <h2>Descricao</h2>
          <div className="product-description">{typed.description}</div>
        </section>

        <section className="section card">
          <h2>Imagens</h2>
          <div className="image-grid">
            {[...(typed.product_images || [])]
              .sort((a, b) => a.position - b.position)
              .map((image) => (
                <figure className="product-image" key={`${image.position}-${image.original_name}`}>
                  {image.local_url || image.url ? (
                    <Image src={image.local_url || image.url || ""} alt={image.original_name} width={180} height={180} unoptimized />
                  ) : (
                    <div className="image-placeholder">Sem imagem</div>
                  )}
                  <figcaption>{String(image.position).padStart(2, "0")} - {image.original_name}</figcaption>
                </figure>
              ))}
          </div>
        </section>

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
                      <td>{integration.code}</td>
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
                            <IntegrationDeleteButton productId={typed.id} integration={integration.integration} />
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
        error_message
      )
    `)
    .eq("id", id)
    .single();

  if (!withLocalImages.error) {
    return withLocalImages.data;
  }

  const fallback = await supabase
    .from("products")
    .select(`
      *,
      product_images (
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
        error_message
      )
    `)
    .eq("id", id)
    .single();

  return fallback.data;
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
    });
  }

  for (const listing of product.listings || []) {
    if (!listing.external_listing_id) {
      continue;
    }

    const isShopee = listing.marketplace === "shopee";
    rows.push({
      key: listing.id,
      integration: isShopee ? "SHOPEE" : "MERCADO_LIVRE",
      name: isShopee ? "Shopee" : "Mercado Livre",
      code: listing.external_listing_id,
      sku: listing.external_sku || "-",
      status: listing.status,
      sentAt: "-",
      canRemove: false
    });
  }

  return rows;
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
