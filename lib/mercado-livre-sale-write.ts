type Row = Record<string, any>;

// Compare-and-set prevents an order trigger from erasing a finance snapshot
// committed after its initial read (including the existing payment RPC).
// A conflict fails before downstream sale-item/stock processing and can retry.
export async function persistMercadoLivreSale(db: {from: (table: string) => any}, values: Row, previous?: Row | null) {
  if (!previous) {
    // Never upsert here: concurrent first observations must not overwrite.
    return db.from('venda').insert(values).select('id').single().throwOnError();
  }
  if (!previous.updated_at) throw new Error('Venda sem versão verificável; persistência financeira abortada.');
  const previousTime = Date.parse(previous.updated_at);
  const updatedValues = {...values, updated_at:new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString()};
  const result = await db.from('venda').update(updatedValues).eq('id', previous.id)
    .eq('updated_at', previous.updated_at).select('id').maybeSingle().throwOnError();
  if (!result.data) throw new Error('Venda alterada durante a captura; repetir com o financeiro atual.');
  return result;
}
