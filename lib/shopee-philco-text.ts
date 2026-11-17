/** Ajuste exclusivo do texto enviado a Shopee para produtos da marca Philco. */
export function normalizeShopeePhilcoPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const explicitBrand = typeof payload.brand === "string" ? payload.brand.trim() : 
    typeof payload.brand_name === "string" ? payload.brand_name.trim() : "";
  const description = typeof payload.description === "string" ? payload.description : "";
  const brandIsPhilco = explicitBrand
    ? explicitBrand.toLocaleLowerCase("pt-BR") === "philco"
    : /(?:^|\r?\n)\s*Marca\s*:\s*Philco\s*(?:\r?$|[\r\n])/im.test(description);

  if (!brandIsPhilco) return payload;

  return {
    ...payload,
    ...(typeof payload.item_name === "string" ? { item_name: payload.item_name.replace(/[./]/g, "") } : {}),
    ...(typeof payload.description === "string" ? { description: payload.description.replace(/[./]/g, "") } : {})
  };
}
