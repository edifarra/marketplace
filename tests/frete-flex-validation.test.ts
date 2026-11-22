import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFreteFlexCity, normalizeFreteFlexCityKey, parseFreteFlexValues } from "../lib/frete-flex-validation";

const validValues = {
  custo_capital_grande_sp: "12.70",
  custo_extremo_sp: "16.97",
  percentual_gris: "0.10",
  percentual_ad_valorem: "0.10",
  peso_limite_kg: "10",
  adicional_kg_acima_10: "1.00"
};

test("parses the configured FLEX rates and accepts Brazilian decimal commas", () => {
  const parsed = parseFreteFlexValues({ ...validValues, custo_capital_grande_sp: "12,70" });
  assert.deepEqual(parsed.data, {
    custo_capital_grande_sp: 12.7,
    custo_extremo_sp: 16.97,
    percentual_gris: 0.1,
    percentual_ad_valorem: 0.1,
    peso_limite_kg: 10,
    adicional_kg_acima_10: 1
  });
});

test("rejects missing, negative, malformed and out-of-range FLEX values", () => {
  assert.match(parseFreteFlexValues({ ...validValues, custo_extremo_sp: "" }).error || "", /Custo Extremos SP/);
  assert.match(parseFreteFlexValues({ ...validValues, custo_capital_grande_sp: "-1" }).error || "", /limite permitido/);
  assert.match(parseFreteFlexValues({ ...validValues, percentual_gris: "100.01" }).error || "", /limite permitido/);
  assert.match(parseFreteFlexValues({ ...validValues, peso_limite_kg: "0" }).error || "", /limite permitido/);
  assert.match(parseFreteFlexValues({ ...validValues, adicional_kg_acima_10: "1e3" }).error || "", /Quilo adicional/);
});

test("normalizes city whitespace and duplicate comparison without losing accents", () => {
  assert.equal(normalizeFreteFlexCity("  Mogi   das Cruzes "), "Mogi das Cruzes");
  assert.equal(normalizeFreteFlexCityKey(" MOGI das CRUZES "), "mogi das cruzes");
  assert.equal(normalizeFreteFlexCityKey("Poá"), "poá");
});
