// Keep each request below the Data API row limit and use a stable order at the caller.
// Query errors must never masquerade as missing items or failed inventory audits.
export async function loadAllSalesRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  source: string
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(`Falha ao carregar ${source}: ${error.message}`);
    if (!data) throw new Error(`Falha ao carregar ${source}: resposta sem dados.`);
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}
