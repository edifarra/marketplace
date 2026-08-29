export function buildMercadoLivreVariationStockPayload(variationIds: Array<string | number>, stock: number) {
  const ids = uniquePositiveIds(variationIds);
  return { variations: ids.map(id => ({ id, available_quantity: normalizedStock(stock) })) };
}

export function buildShopeeStockPayload(itemId: string | number, modelIds: Array<string | number>, stock: number) {
  const ids = uniquePositiveIds(modelIds);
  return {
    item_id: Number(itemId),
    stock_list: (ids.length ? ids : [0]).map(modelId => ({
      model_id: modelId,
      seller_stock: [{ stock: normalizedStock(stock) }]
    }))
  };
}

function uniquePositiveIds(values: Array<string | number>) {
  return [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
}

function normalizedStock(value: number) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}
