export type FreteFlexValues = {
  custo_capital_grande_sp: number;
  custo_extremo_sp: number;
  percentual_gris: number;
  percentual_ad_valorem: number;
  peso_limite_kg: number;
  adicional_kg_acima_10: number;
};

const VALUE_FIELDS = [
  ["custo_capital_grande_sp", "Custo Capital / Grande SP", 0, 1_000_000],
  ["custo_extremo_sp", "Custo Extremos SP", 0, 1_000_000],
  ["percentual_gris", "GRIS", 0, 100],
  ["percentual_ad_valorem", "Ad Valorem", 0, 100],
  ["peso_limite_kg", "Limite de peso", 0.001, 1_000_000],
  ["adicional_kg_acima_10", "Quilo adicional", 0, 1_000_000]
] as const;

export function parseFreteFlexValues(values: Record<string, unknown>): { data?: FreteFlexValues; error?: string } {
  const parsed: Partial<FreteFlexValues> = {};
  for (const [field, label, min, max] of VALUE_FIELDS) {
    const raw = String(values[field] ?? "").trim().replace(",", ".");
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return { error: `Informe um valor válido para ${label}.` };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) return { error: `${label} está fora do limite permitido.` };
    parsed[field] = value;
  }
  return { data: parsed as FreteFlexValues };
}

export function normalizeFreteFlexCity(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeFreteFlexCityKey(value: unknown) {
  return normalizeFreteFlexCity(value).toLocaleLowerCase("pt-BR");
}
