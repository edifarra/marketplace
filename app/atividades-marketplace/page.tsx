import Link from "next/link";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

export default async function ActivitiesPage({ searchParams }: { searchParams?: { page?: string } }) {
  const page = Math.max(1, Number(searchParams?.page || 1));
  const from = (page - 1) * PAGE_SIZE;
  const result = await supabaseAdmin().from("marketplace_activities")
    .select("id,marketplace,order_id,description,value,status,item_count,received_at", { count: "exact" })
    .order("received_at", { ascending: false }).range(from, from + PAGE_SIZE - 1);
  const rows = result.data || [];
  const count = result.count || 0;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Atividades Marketplace</h1><div className="subtitle">Todos os eventos recebidos por webhook.</div></div></div>
    {result.error && <div className="form-error">{result.error.message}</div>}
    <section className="card"><div className="muted">Registro {count ? from + 1 : 0}-{Math.min(from + PAGE_SIZE, count)} de {count.toLocaleString("pt-BR")}</div>
      <div className="table-wrap"><table><thead><tr><th>Marketplace</th><th>ID Venda</th><th>Descricao</th><th>Valor</th><th>Status</th><th>Itens</th><th>Data/Hora</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id}><td>{row.marketplace === "shopee" ? "Shopee" : "ML"}</td><td><Link href={`/atividades-marketplace/${row.id}`}>{row.order_id || "-"}</Link></td><td>{row.description || "-"}</td><td>{Number(row.value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td><td>{row.status}</td><td>{row.item_count}</td><td>{new Date(row.received_at).toLocaleString("pt-BR")}</td></tr>)}
        {!rows.length && <tr><td colSpan={7}>Nenhuma atividade registrada.</td></tr>}
      </tbody></table></div>
      <div className="form-actions"><Link className="secondary" href="?page=1">Primeira</Link><Link className="secondary" href={`?page=${Math.max(1, page - 1)}`}>Anterior</Link><span>Pagina {page} de {pages}</span><Link className="secondary" href={`?page=${Math.min(pages, page + 1)}`}>Proxima</Link><Link className="secondary" href={`?page=${pages}`}>Ultima</Link></div>
    </section></section></main>;
}
