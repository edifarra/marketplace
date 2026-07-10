import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
export default async function ActivityDetail({ params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const [activity, history] = await Promise.all([
    db.from("marketplace_activities").select("*,venda(*,venda_item(*),status_venda(*))").eq("id", params.id).maybeSingle(),
    db.from("marketplace_activity_history").select("*").eq("activity_id", params.id).order("created_at")
  ]);
  return <main className="shell"><Sidebar /><section className="main"><h1>Detalhes da atividade</h1><a className="secondary" href="/atividades-marketplace">Voltar</a>
    <section className="card section"><h2>Evento, venda e itens</h2><pre className="product-description">{JSON.stringify(activity.data || { erro: activity.error?.message }, null, 2)}</pre></section>
    <section className="card section"><h2>Historico de processamento</h2><pre className="product-description">{JSON.stringify(history.data || [], null, 2)}</pre></section>
  </section></main>;
}
