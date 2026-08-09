"use client";

import { useEffect, useState } from "react";
import type { PriceEvaluation } from "@/lib/price-evaluation";
import { PriceEvaluationDetails } from "./price-evaluation-details";

const RESULT_KEY = "price-evaluation:last-result";
const QUERY_KEY = "price-evaluation:last-query";

export function PriceSearchForm({ initialQuery, initialOnline }: { initialQuery: string; initialOnline: boolean }) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    if (!initialQuery) setQuery(sessionStorage.getItem(QUERY_KEY) || "");
  }, [initialQuery]);

  return <form className="price-search" method="get">
    <label>SKU ou string da foto<input name="busca" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex.: 456PP ou PPSA_UN55TU8000G_BN9477123_ID 456_01" autoFocus /></label>
    <label className="checkbox-label"><input type="checkbox" name="online" value="1" defaultChecked={initialOnline} /> Usar dados Online</label>
    <button className="primary" type="submit">Avaliar preço</button>
  </form>;
}

export function PersistentPriceEvaluation({ initial, query }: { initial: PriceEvaluation | null; query: string }) {
  const [evaluation, setEvaluation] = useState<PriceEvaluation | null>(initial);

  useEffect(() => {
    if (initial) {
      sessionStorage.setItem(RESULT_KEY, JSON.stringify(initial));
      sessionStorage.setItem(QUERY_KEY, query);
      setEvaluation(initial);
      return;
    }
    if (query) return;
    const stored = sessionStorage.getItem(RESULT_KEY);
    if (!stored) return;
    try { setEvaluation(JSON.parse(stored) as PriceEvaluation); }
    catch { sessionStorage.removeItem(RESULT_KEY); }
  }, [initial, query]);

  return evaluation ? <PriceEvaluationDetails initial={evaluation} /> : null;
}
