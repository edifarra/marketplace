import { Sidebar } from "../components/sidebar";
import { evaluatePrice, PriceEvaluation } from "@/lib/price-evaluation";
import { PersistentPriceEvaluation, PriceSearchForm } from "./price-evaluation-session";

export const dynamic = "force-dynamic";

export default async function PriceEvaluationPage({ searchParams }: { searchParams?: Promise<{ busca?: string; online?: string }> }) {
  const urlParams = (await searchParams) ?? {};
  const query = String(urlParams?.busca || "");
  let evaluation: PriceEvaluation | null = null;
  let error = "";
  if (query) {
    try { evaluation = await evaluatePrice(query, { forceOnline: urlParams?.online === "1" }); }
    catch (cause) { error = cause instanceof Error ? cause.message : "Não foi possível realizar a avaliação."; }
  }
  return <main className="shell"><Sidebar /><section className="main">
    <div className="topbar"><div><h1>Avaliação de Preço</h1><div className="subtitle">Consulte anúncios do Mercado Livre e confira a formação do preço sugerido.</div></div></div>
    <section className="card price-search-card">
      <PriceSearchForm initialQuery={query} initialOnline={urlParams?.online === "1"} />
    </section>
    {error && <div className="form-error section">{error}</div>}
    <PersistentPriceEvaluation initial={evaluation} query={query} />
  </section></main>;
}
