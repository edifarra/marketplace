import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { CategoryMappingRow } from "./category-mapping-row";
export const dynamic = "force-dynamic";

export default async function CategoriesPage({ searchParams }: { searchParams?: { erro?: string; sucesso?: string } }) {
  const db = supabaseAdmin();
  const [types, mappings] = await Promise.all([
    db.from("config_types").select("marketplace_category").not("marketplace_category", "is", null),
    db.from("marketplace_category_mappings").select("*")
  ]);
  const categories = [...new Set((types.data || []).map(row => String(row.marketplace_category || "").trim()).filter(Boolean))].sort();
  const byCategory = new Map((mappings.data || []).map(row => [String(row.internal_category), row]));
  return <main className="shell"><Sidebar /><section className="main"><div className="topbar"><div><h1>Categorias Marketplace</h1><div className="subtitle">DE-PARA das categorias internas com Mercado Livre, Shopee e Tiny.</div></div></div>
    {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}{searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
    <section className="category-mapping-list">
      {categories.map(category => <CategoryMappingRow key={category} category={category} mapping={byCategory.get(category)} />)}
      {!categories.length && <div className="card">Nenhuma categoria interna configurada.</div>}
    </section></section></main>;
}
