import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/app/components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { CaseDetail } from "../case-grid";
export const dynamic = "force-dynamic";
export default async function CaseDestination({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const { data: row } = await supabaseAdmin().from("marketplace_cases").select("id,external_case_id").eq("id", id).maybeSingle().throwOnError();
  if (!row) notFound();
  return <main className="shell"><Sidebar/><section className="main"><div className="topbar"><h1>Caso #{row.external_case_id}</h1><Link href="/central-reclamacoes" className="secondary">← Voltar à Central</Link></div><section className="card"><CaseDetail id={row.id}/></section></section></main>;
}
