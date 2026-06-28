import { Sidebar } from "../components/sidebar";
import { getStockConsolidation, type StockIntegrationCell } from "@/lib/stock-consolidation";

export const dynamic = "force-dynamic";

export default async function StockPage() {
  const data = await getStockConsolidation();

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Gestao de estoque</h1>
            <div className="subtitle">Consolidacao dos produtos do sistema com os estoques recuperados nas integracoes.</div>
          </div>
          <a className="secondary" href="/configuracoes/marketplace">Configurar MarketPlace</a>
        </div>

        {data.errors.length > 0 && (
          <section className="form-error">
            {data.errors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </section>
        )}

        <section className="card">
          <div className="table-toolbar">
            <div>
              <h2>SIST</h2>
              <div className="muted">{data.systemRows.length} produto(s) do sistema.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SIST</th>
                  <th>SKU</th>
                  <th>Titulo</th>
                  <th>Estoque</th>
                  {data.columns.map((column) => (
                    <th key={column.id}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.systemRows.length === 0 ? (
                  <tr>
                    <td colSpan={4 + data.columns.length}>Nenhum produto no sistema.</td>
                  </tr>
                ) : (
                  data.systemRows.map((row) => (
                    <tr key={row.productId}>
                      <td>{row.system}</td>
                      <td>{row.sku}</td>
                      <td>{row.title}</td>
                      <td>{row.stock}</td>
                      {data.columns.map((column) => (
                        <td key={column.id}>
                          <IntegrationCell cell={row.integrations[column.id]} />
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section card">
          <div className="table-toolbar">
            <div>
              <h2>INTEG</h2>
              <div className="muted">{data.integrationOnlyRows.length} SKU(s) encontrados apenas nas integracoes.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>INTEG</th>
                  <th>SKU</th>
                  <th>Titulo</th>
                  {data.columns.map((column) => (
                    <th key={column.id}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.integrationOnlyRows.length === 0 ? (
                  <tr>
                    <td colSpan={3 + data.columns.length}>Nenhum produto exclusivo das integracoes.</td>
                  </tr>
                ) : (
                  data.integrationOnlyRows.map((row) => (
                    <tr key={row.sku}>
                      <td>{row.system}</td>
                      <td>{row.sku}</td>
                      <td>{row.title}</td>
                      {data.columns.map((column) => (
                        <td key={column.id}>
                          <IntegrationCell cell={row.integrations[column.id]} />
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}

function IntegrationCell({ cell }: { cell?: StockIntegrationCell }) {
  if (!cell) {
    return <span className="muted">-</span>;
  }

  return (
    <span className="stock-cell" data-listing-ids={cell.listingIds.join(",")}>
      <strong>{cell.stock}</strong>
      <span>{formatMarketplaceStatus(cell.status)}</span>
    </span>
  );
}

function formatMarketplaceStatus(status: string) {
  const labels: Record<string, string> = {
    active: "ativo",
    paused: "inativo",
    closed: "inativo",
    under_review: "revisao",
    misto: "misto"
  };

  return labels[status] || status || "-";
}
