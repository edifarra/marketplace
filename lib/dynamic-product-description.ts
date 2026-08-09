import { applyTemplate } from "./pipeline";

type ProductDescriptionData = {
  sku?: string | null;
  title?: string | null;
  model?: string | null;
  version?: string | null;
  board_code?: string | null;
  description?: string | null;
};

type TypeDescriptionConfig = {
  description?: string | null;
  description_template?: string | null;
};

type BrandDescriptionConfig = {
  name?: string | null;
};

type SpecialDescriptionConfig = {
  include_description?: string | null;
  remove_description?: string | null;
};

export function buildProductDescription(
  product: ProductDescriptionData,
  type: TypeDescriptionConfig | null | undefined,
  brand: BrandDescriptionConfig | null | undefined,
  special?: SpecialDescriptionConfig | null
) {
  if (String(product.description || "").trim()) {
    return String(product.description).trim();
  }
  let description = applyTemplate(
    type?.description_template || "Produto: [NOME_PRODUTO_COMPLETO]",
    {
      nome_produto_completo: String(product.title || ""),
      tipo: String(type?.description || ""),
      marca: String(brand?.name || ""),
      modelo: String(product.model || ""),
      versao: String(product.version || ""),
      codigo: String(product.board_code || ""),
      especial: String(special?.include_description || ""),
      sku: String(product.sku || "")
    }
  );

  return removeSpecialDescriptionTexts(description, special?.remove_description);
}

function removeSpecialDescriptionTexts(description: string, configuredRemovals?: string | null) {
  const removals = String(configuredRemovals || "")
    .split(";")
    .map((text) => text.replace(/^\s*(?:<br\s*\/?>\s*)+/i, "").replace(/(?:\s*<br\s*\/?>)+\s*$/i, ""))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const result = removals.reduce((current, text) => {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return current.replace(new RegExp(escaped, "gi"), "");
  }, description);

  return result.replace(/(?:<br\s*\/?>\s*){2,}/gi, "<br>").trim();
}
