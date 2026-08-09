import { Sidebar } from "../components/sidebar";
import { evaluatePrice, PriceEvaluation } from "@/lib/price-evaluation";
import { PersistentPriceEvaluation, PriceSearchForm } from "./price-evaluation-session";

export const dynamic = "force-dynamic";

export default async function PriceEvaluationPage({ searchParams }: { searchParams?: { busca?: string; online?: string } }) {
  const query = String(searchParams?.busca || "");
  let evaluation: PriceEvaluation | null = null;
  let error = "";
  if (query) {
    try { evaluation = await evaluatePrice(query, { forceOnline: searchParams?.online === "1" }); }
    catch (cause) { error = cause instanceof Error ? cause.message : "Não foi possível realizar a avaliação."; }
  }
  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Avaliação de Preço</h1><div className="subtitle">Consulte anúncios do Mercado Livre e confira a formação do preço sugerido.</div></div></div>
    <section className="card price-search-card">
      <PriceSearchForm initialQuery={query} initialOnline={searchParams?.online === "1"} />
    </section>
    {error && <div className="form-error section">{error}</div>}
    <PersistentPriceEvaluation initial={evaluation} query={query} />
  </section></main>;
}
