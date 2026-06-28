import { createClient } from "@supabase/supabase-js";
import { Sidebar } from "../components/sidebar";
import { listLocalProductImages } from "@/lib/local-images";
import { PhotosSelection } from "./photos-selection";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type ImageRelation = {
  local_url?: string | null;
  url?: string | null;
  products?: {
    sku?: string | null;
    stock?: number | null;
  } | null;
};

export default async function FotosPage() {
  const localImages = await listLocalProductImages();
  const relations = await getImageRelations();
  const relationByUrl = new Map<string, ImageRelation>();

  for (const relation of relations) {
    if (relation.local_url) relationByUrl.set(relation.local_url, relation);
    if (relation.url?.startsWith("/uploads/products/")) relationByUrl.set(relation.url, relation);
  }

  const photos = localImages.map((image) => {
    const relation = relationByUrl.get(image.localUrl);
    return {
      name: image.name,
      localUrl: image.localUrl,
      sizeBytes: image.sizeBytes,
      modifiedAt: image.modifiedAt,
      relatedSku: relation?.products?.sku || undefined,
      relatedStock: Number(relation?.products?.stock ?? 0)
    };
  });

  const relatedProducts = new Map<string, number>();
  for (const photo of photos) {
    if (photo.relatedSku) {
      relatedProducts.set(photo.relatedSku, photo.relatedStock || 0);
    }
  }

  const withStock = [...relatedProducts.values()].filter((stock) => stock > 0).length;
  const withoutStock = [...relatedProducts.values()].filter((stock) => stock <= 0).length;
  const totalBytes = photos.reduce((sum, photo) => sum + photo.sizeBytes, 0);

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Fotos</h1>
            <div className="subtitle">Fotos locais processadas e prontas para uso nos produtos.</div>
          </div>
        </div>

        <section className="grid metrics">
          <Metric label="Quantidade de Fotos" value={String(photos.length)} />
          <Metric label="Produtos com Estoque" value={String(withStock)} />
          <Metric label="Produtos sem Estoque" value={String(withoutStock)} />
          <Metric label="Espaco ocupado" value={`${(totalBytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB`} />
        </section>

        <section className="section card">
          <div className="table-toolbar">
            <div>
              <h2>Fotos locais</h2>
              <div className="muted">{photos.length} arquivo(s) encontrado(s)</div>
            </div>
          </div>
          {photos.length === 0 ? (
            <div className="muted">Nenhuma foto local encontrada.</div>
          ) : (
            <PhotosSelection photos={photos} />
          )}
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

async function getImageRelations() {
  const { data, error } = await supabase
    .from("product_images")
    .select(`
      local_url,
      url,
      products (
        sku,
        stock
      )
    `);

  if (error) {
    const fallback = await supabase
      .from("product_images")
      .select(`
        url,
        products (
          sku,
          stock
        )
      `);

    return (fallback.data ?? []) as ImageRelation[];
  }

  return (data ?? []) as ImageRelation[];
}
