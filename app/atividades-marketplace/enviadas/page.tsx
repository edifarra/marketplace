import Link from "next/link";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { formatSaoPauloDateTime } from "@/lib/date-time";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;
type Params = { page?: string; sku?: string; type?: string; store?: string; from?: string; to?: string };

export default async function SentActivities({ searchParams }: { searchParams?: Params }) {
  const db = supabaseAdmin();
  const page = Math.max(1, Number(searchParams?.page || 1));
  const filters = { sku: String(searchParams?.sku || "").trim(), type: String(searchParams?.type || ""), store: String(searchParams?.store || ""), from: String(searchParams?.from || ""), to: String(searchParams?.to || "") };
  let query = db.from("outgoing_marketplace_activities").select("*,config_marketplace_accounts(name,nickname)", { count: "exact" });
  if (filters.sku) query = query.ilike("sku", `%${filters.sku.replace(/[%_]/g, "")}%`);
  if (filters.type) query = query.eq("activity_type", filters.type);
  if (filters.store) query = query.eq("marketplace_account_id", filters.store);
  if (filters.from) query = query.gte("created_at", `${filters.from}T00:00:00-03:00`);
  if (filters.to) query = query.lte("created_at", `${filters.to}T23:59:59-03:00`);
  const from = (page - 1) * PAGE_SIZE;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [activities, accounts, monthRows] = await Promise.all([
    query.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1),
    db.from("config_marketplace_accounts").select("id,name,nickname,marketplace").eq("active", true).order("name"),
    db.from("outgoing_marketplace_activities").select("status").gte("created_at", monthStart.toISOString())
  ]);
  const total = activities.count || 0, pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), rows = activities.data || [];
  const monthSummary = (monthRows.data || []).reduce((summary, row) => {
    if (["queued", "processing", "retry"].includes(row.status)) summary.queued += 1;
    else if (row.status === "completed") summary.completed += 1;
    else if (row.status === "error") summary.error += 1;
    return summary;
  }, { queued: 0, completed: 0, error: 0 });
  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Atividades Enviadas</h1><div className="subtitle">Fila auditada de todas as comunicações externas. Histórico mantido por 60 dias.</div></div></div>
    <section className="stats-grid"><div className="stat-card"><span>Em fila no mês</span><strong>{monthSummary.queued}</strong></div><div className="stat-card"><span>Concluído no mês</span><strong>{monthSummary.completed}</strong></div><div className="stat-card"><span>Erro no mês</span><strong>{monthSummary.error}</strong></div></section>
    {activities.error && <div className="form-error">{activities.error.message}</div>}
    <section className="card form-card"><form method="get"><div className="table-toolbar"><div><h2>Filtros</h2><div className="muted">Filtre por atividade, período ou loja.</div></div><div className="row-actions"><button className="secondary">Aplicar</button><a className="secondary link-button" href="/atividades-marketplace/enviadas">Limpar</a></div></div>
      <div className="form-grid"><label>SKU<input name="sku" placeholder="Buscar por SKU" defaultValue={filters.sku} /></label><label>Tipo de atividade<select name="type" defaultValue={filters.type}><option value="">Todas</option><option value="stock_update">Atualizar estoque</option><option value="listing_create">Incluir anúncio</option><option value="listing_update">Atualizar atributos</option><option value="listing_delete">Excluir anúncio</option><option value="answer_send">Resposta enviada</option><option value="question_answer">Pergunta respondida</option></select></label>
      <label>De<input type="date" name="from" defaultValue={filters.from}/></label><label>Até<input type="date" name="to" defaultValue={filters.to}/></label>
      <label>Loja<select name="store" defaultValue={filters.store}><option value="">Todas</option>{(accounts.data || []).map(a => <option key={a.id} value={a.id}>{a.nickname || a.name}</option>)}</select></label></div>
    </form></section>
    <section className="card"><div className="muted">Registros {total ? from + 1 : 0}-{Math.min(from + PAGE_SIZE, total)} de {total}</div><div className="table-wrap"><table><thead><tr><th>Atividade</th><th>SKU</th><th>Produto</th><th>Data/Hora</th><th>Loja</th><th>Status</th><th>Tentativas</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td><Link href={`/atividades-marketplace/enviadas/${row.id}`}>{activityLabel(row.activity_type)}</Link></td><td>{row.sku}</td><td>{row.product_name || "-"}</td><td>{formatSaoPauloDateTime(row.created_at)}</td><td><span className={`store-mini-logo ${row.destination}`}>{row.destination === "mercado_livre" ? "ML" : row.destination === "shopee" ? "S" : "T"}</span> {row.config_marketplace_accounts?.nickname || row.config_marketplace_accounts?.name || "Tiny"}</td><td>{statusLabel(row.status)}</td><td>{row.attempt_count}/5</td></tr>)}
      {!rows.length && <tr><td colSpan={7}>Nenhuma atividade enviada encontrada.</td></tr>}
    </tbody></table></div><div className="form-actions"><Link className="secondary" href={href(Math.max(1,page-1),filters)}>Anterior</Link><span>Página {Math.min(page,pages)} de {pages}</span><Link className="secondary" href={href(Math.min(pages,page+1),filters)}>Próxima</Link></div></section>
  </section></main>;
}
function href(page:number, filters:Record<string,string>){return `/atividades-marketplace/enviadas?${new URLSearchParams({...filters,page:String(page)})}`;}
function activityLabel(value:string){return ({stock_update:"Atualizar estoque",listing_create:"Incluir anúncio",listing_update:"Atualizar atributos",listing_delete:"Excluir anúncio",answer_send:"Resposta enviada",question_answer:"Pergunta respondida"} as Record<string,string>)[value] || value;}
function statusLabel(value:string){return ({queued:"Em fila",processing:"Em processamento",retry:"Em fila",completed:"Concluído",error:"Erro"} as Record<string,string>)[value] || value;}
