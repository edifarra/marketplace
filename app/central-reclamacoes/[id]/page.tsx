import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/app/components/sidebar";
import { cachedCaseDetail, caseReadScope } from "@/lib/marketplace-case-read-cache";
import { CaseDetail } from "../case-grid";
export const dynamic = "force-dynamic";
export default async function CaseDestination({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const context = await caseReadScope();
  const detail = await cachedCaseDetail(id, context.scope, context.revision);
  if (!detail) notFound();
  return <main className="shell"><Sidebar/><section className="main"><div className="topbar"><h1>Caso #{detail.row.external_case_id}</h1><Link href="/central-reclamacoes" className="secondary">← Voltar à Central</Link></div><section className="card"><CaseDetail id={id} initialData={detail} initialRow={detail.row} cacheScope={context.scope} cacheRevision={context.revision}/></section></section></main>;
}
