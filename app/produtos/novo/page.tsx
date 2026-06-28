import { ProductForm } from "./product-form";
import { Sidebar } from "@/app/components/sidebar";
import { getProductFormOptions } from "@/lib/products";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const options = await getProductFormOptions();

  return (
    <main className="shell">
      <Sidebar />

      <section className="main">
        <div className="topbar">
          <div>
            <h1>Novo Produto</h1>
            <div className="subtitle">
              Cadastro manual com SKU, titulo, descricao e anuncios draft gerados pelas configuracoes do Supabase.
            </div>
          </div>
        </div>

        <ProductForm options={options} />
      </section>
    </main>
  );
}
