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
    <section className="card"><div className="table-wrap"><table><thead><tr><th>Categoria interna</th><th>Mercado Livre</th><th>Shopee</th><th>Tiny</th><th>Acao</th></tr></thead><tbody>
      {categories.map(category => <CategoryMappingRow key={category} category={category} mapping={byCategory.get(category)} />)}
      {!categories.length && <tr><td colSpan={5}>Nenhuma categoria interna configurada.</td></tr>}
    </tbody></table></div></section></section></main>;
}
