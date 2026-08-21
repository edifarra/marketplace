import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { formatSaoPauloDateTime } from "@/lib/date-time";
export const dynamic = "force-dynamic";
export default async function SentActivityDetail({params}:{params:{id:string}}){
  const db=supabaseAdmin(); const [activity,history]=await Promise.all([
    db.from("outgoing_marketplace_activities").select("*,config_marketplace_accounts(name,nickname)").eq("id",params.id).maybeSingle(),
    db.from("outgoing_marketplace_activity_history").select("*").eq("activity_id",params.id).order("created_at")]);
  const row=activity.data;
  return <main className="shell"><Sidebar/><section className="main"><h1>Detalhe da atividade enviada</h1><a className="secondary" href="/atividades-marketplace/enviadas">Voltar</a>
    {!row?<section className="card section">Atividade não encontrada.</section>:<><section className="card section"><h2>{row.sku} — {row.product_name||"Produto"}</h2><div className="activity-change-grid"><div><span>Informação anterior</span><pre className="product-description">{JSON.stringify(row.previous_data,null,2)}</pre></div><div><span>Informação solicitada</span><pre className="product-description">{JSON.stringify(row.requested_data,null,2)}</pre></div><div><span>Informação confirmada</span><pre className="product-description">{JSON.stringify(row.confirmed_data,null,2)}</pre></div></div>{row.processing_error&&<div className="form-error">{row.processing_error}</div>}</section>
    <section className="card section"><h2>Processamento e validação</h2><div className="table-wrap"><table><thead><tr><th>Data/Hora</th><th>Tentativa</th><th>Etapa</th><th>Status</th><th>Detalhes</th></tr></thead><tbody>{(history.data||[]).map(item=><tr key={item.id}><td>{formatSaoPauloDateTime(item.created_at)}</td><td>{item.attempt||"-"}</td><td>{item.stage}</td><td>{item.status}</td><td><pre className="activity-json">{JSON.stringify(item.details,null,2)}</pre></td></tr>)}</tbody></table></div></section></>}
  </section></main>;
}
