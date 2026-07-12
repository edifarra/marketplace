import { Sidebar } from "../components/sidebar";
import { ConfirmActionButton } from "./confirm-action-button";
import { StockSyncButton } from "./stock-sync-button";
import { LinkMarketplaceButton } from "./link-marketplace-button";
import {
  deleteSystemProductOnlyAction,
  importMarketplaceSkuAction,
  removeMarketplaceListingsAction,
  removeMarketplaceOnlyListingsAction,
  sendMissingMarketplacesAction,
  updateDivergentStockAction
} from "./actions";
import {
  effectiveMarketplaceStock,
  getMigrationStockData,
  type MarketplaceLink,
  type MigrationStockStatus,
  type MigrationStockView
} from "@/lib/migration-stock";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: {
    view?: string;
    erro?: string;
    sucesso?: string;
    status?: string;
  };
};

const views: Array<{ key: MigrationStockView; title: string; description: string }> = [
  {
    key: "marketplace-only",
    title: "Produtos dos marketplaces nao encontrados no sistema",
    description: "SKUs existentes nas integracoes ativas e ainda ausentes no SIST."
  },
  {
    key: "system-only",
    title: "Produtos no sistema que nao existem em nenhum marketplace",
    description: "Produtos cadastrados no SIST sem anuncio em qualquer marketplace ativo."
  },
  {
    key: "missing-marketplace",
    title: "Produtos no sistema que nao existem em pelo menos um marketplace",
    description: "Produtos que existem em alguma integracao, mas nao em todas as contas ativas."
  },
  {
    key: "stock-divergent",
    title: "Produtos com estoque divergente",
    description: "Compara o estoque oficial do SIST com os estoques existentes nos marketplaces."
  }
];

export default async function StockPage({ searchParams }: PageProps) {
  const selectedView = parseView(searchParams?.view);
  const selectedStatus = parseStatus(searchParams?.status);
  const data = await getMigrationStockData(selectedView, selectedStatus);

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Migracao e Estoque</h1>
            <div className="subtitle">Consolidacao por SKU entre SIST e marketplaces configurados.</div>
          </div>
          <a className="secondary" href="/configuracoes/marketplace">Configurar MarketPlace</a>
        </div>

        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
        {data.errors.length > 0 && (
          <section className="form-error">
            {data.errors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </section>
        )}

        <section className="card form-card">
          <div className="table-toolbar">
            <div>
              <h2>Sincronizar marketplaces</h2>
              <div className="muted">Atualize manualmente o estoque das contas conectadas antes de comparar os produtos.</div>
            </div>
            <div className="row-actions">
              {data.accounts.length === 0 ? (
                <span className="muted">Nenhuma conta ativa conectada.</span>
              ) : (
                data.accounts.map((account) => (
                  <StockSyncButton key={account.id} accountId={account.id} accountName={account.name} />
                ))
              )}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="table-toolbar">
            <div><h2>Resumo</h2><div className="muted">Filtre os anuncios pelo status informado pelo marketplace.</div></div>
            <form method="get" className="row-actions">
              <input type="hidden" name="view" value={selectedView} />
              <label htmlFor="status">Status</label>
              <select id="status" name="status" defaultValue={selectedStatus}>
                <option value="all">Todos</option>
                <option value="active">Ativo</option>
                <option value="paused">Pausado / inativo</option>
              </select>
              <button className="secondary compact" type="submit">Filtrar</button>
            </form>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Analise</th>
                  <th>Quantidade</th>
                  <th>Processamento</th>
                  <th>Acao</th>
                </tr>
              </thead>
              <tbody>
                {views.map((view) => (
                  <tr key={view.key}>
                    <td>
                      <strong>{view.title}</strong>
                      <div className="muted">{view.description}</div>
                    </td>
                    <td>{summaryValue(data.summary, view.key)}</td>
                    <td>{view.key === selectedView ? "Exibindo abaixo" : "-"}</td>
                    <td>
                      <a className="secondary compact" href={`/estoque?view=${view.key}&status=${selectedStatus}`}>Ver Produtos</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section card">
          <div className="table-toolbar">
            <div>
              <h2>{views.find((view) => view.key === selectedView)?.title}</h2>
              <div className="muted">{data.rows.length} SKU(s) encontrado(s).</div>
            </div>
          </div>

          {selectedView === "stock-divergent" ? (
            <DivergentStockTable rows={data.rows} accounts={data.accounts} />
          ) : selectedView === "system-only" ? (
            <SystemOnlyTable rows={data.rows} />
          ) : (
            <MarketplacePresenceTable rows={data.rows} view={selectedView} status={selectedStatus} />
          )}
        </section>
      </section>
    </main>
  );
}

function MarketplacePresenceTable({ rows, view, status }: { rows: Awaited<ReturnType<typeof getMigrationStockData>>["rows"]; view: MigrationStockView; status: MigrationStockStatus }) {
  const isMarketplaceOnly = view === "marketplace-only";
  const isMissingMarketplace = view === "missing-marketplace";

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{isMarketplaceOnly ? "INTEG" : "SIST"}</th>
            <th>SKU</th>
            <th>Titulo</th>
            <th>Valor</th>
            <th>Estoque</th>
            <th>Marketplaces</th>
            <th>Acoes</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7}>Nenhum produto encontrado.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.sku}>
                <td>{isMarketplaceOnly ? "INTEG" : "SIST"}</td>
                <td>{row.sku}</td>
                <td>{row.title}</td>
                <td>{formatCurrency(row.price)}</td>
                <td>{row.systemStock ?? maxMarketplaceStock(row.marketplaces)}</td>
                <td><MarketplaceBadges links={row.marketplaces} /></td>
                <td>
                  <div className="row-actions">
                    {isMarketplaceOnly && <ActionForm sku={row.sku} action={importMarketplaceSkuAction} label="Cadastrar" />}
                    {isMarketplaceOnly && <LinkMarketplaceButton sku={row.sku} status={status} />}
                    {isMarketplaceOnly && (
                      <ActionForm
                        sku={row.sku}
                        action={removeMarketplaceOnlyListingsAction}
                        label="Excluir"
                        danger
                        confirm="Deseja remover/inativar os anuncios deste SKU nos marketplaces?"
                      />
                    )}
                    {isMissingMarketplace && <ActionForm sku={row.sku} action={sendMissingMarketplacesAction} label="Enviar" />}
                    {isMissingMarketplace && (
                      <ActionForm
                        sku={row.sku}
                        action={removeMarketplaceListingsAction}
                        label="Excluir"
                        danger
                        confirm="Deseja remover/inativar os anuncios existentes deste SKU nos marketplaces?"
                      />
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function SystemOnlyTable({ rows }: { rows: Awaited<ReturnType<typeof getMigrationStockData>>["rows"] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>SIST</th>
            <th>SKU</th>
            <th>Titulo</th>
            <th>Valor</th>
            <th>Estoque</th>
            <th>Acoes</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6}>Nenhum produto encontrado.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.sku}>
                <td>SIST</td>
                <td>{row.sku}</td>
                <td>{row.title}</td>
                <td>{formatCurrency(row.price)}</td>
                <td>{row.systemStock ?? 0}</td>
                <td>
                  <div className="row-actions">
                    <ActionForm sku={row.sku} action={sendMissingMarketplacesAction} label="Enviar" />
                    <ActionForm
                      sku={row.sku}
                      action={deleteSystemProductOnlyAction}
                      label="Excluir"
                      danger
                      confirm="Deseja excluir este produto do sistema?"
                    />
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function DivergentStockTable({
  rows,
  accounts
}: {
  rows: Awaited<ReturnType<typeof getMigrationStockData>>["rows"];
  accounts: Awaited<ReturnType<typeof getMigrationStockData>>["accounts"];
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Titulo</th>
            <th>Valor</th>
            <th>Estoque SIST</th>
            {accounts.map((account) => (
              <th key={account.id}>{account.name}</th>
            ))}
            <th>Acoes</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5 + accounts.length}>Nenhum estoque divergente.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.sku}>
                <td>{row.sku}</td>
                <td>{row.title}</td>
                <td>{formatCurrency(row.price)}</td>
                <td>{row.systemStock ?? 0}</td>
                {accounts.map((account) => {
                  const links = row.marketplaces.filter((link) => link.marketplace_account_id === account.id);
                  return <td key={account.id}>{links.length ? links.map(formatStockStatus).join(" / ") : "-"}</td>;
                })}
                <td><ActionForm sku={row.sku} action={updateDivergentStockAction} label="Atualizar Estoque" /></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ActionForm({
  sku,
  action,
  label,
  danger = false,
  confirm
}: {
  sku: string;
  action: (formData: FormData) => Promise<void>;
  label: string;
  danger?: boolean;
  confirm?: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="sku" value={sku} />
      {confirm ? (
        <ConfirmActionButton className={danger ? "danger compact" : "secondary compact"} message={confirm}>
          {label}
        </ConfirmActionButton>
      ) : (
        <button className={danger ? "danger compact" : "secondary compact"} type="submit">{label}</button>
      )}
    </form>
  );
}

function MarketplaceBadges({ links }: { links: MarketplaceLink[] }) {
  if (links.length === 0) {
    return <span className="muted">-</span>;
  }

  return (
    <div className="marketplace-logos">
      {links.map((link) => (
        <span
          className={`marketplace-logo ${link.marketplace === "shopee" ? "shopee" : "mercado-livre"}`}
          key={link.id}
          title={`${link.marketplace_account_id} | ${link.marketplace_product_id}`}
        >
          {link.marketplace === "shopee" ? "SH" : "ML"}
        </span>
      ))}
    </div>
  );
}

function formatStockStatus(link: MarketplaceLink) {
  return `${effectiveMarketplaceStock(link)} ${statusInitial(link.status_anuncio)}`;
}

function statusInitial(status: string) {
  return ["active"].includes(status) ? "A" : "I";
}

function maxMarketplaceStock(links: MarketplaceLink[]) {
  return Math.max(0, ...links.map((link) => effectiveMarketplaceStock(link)));
}

function formatCurrency(value: number) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function summaryValue(summary: Awaited<ReturnType<typeof getMigrationStockData>>["summary"], view: MigrationStockView) {
  const map = {
    "marketplace-only": summary.marketplaceOnly,
    "system-only": summary.systemOnly,
    "missing-marketplace": summary.missingMarketplace,
    "stock-divergent": summary.stockDivergent
  };
  return map[view];
}

function parseView(value: string | undefined): MigrationStockView {
  if (value === "system-only" || value === "missing-marketplace" || value === "stock-divergent") {
    return value;
  }

  return "marketplace-only";
}

function parseStatus(value: string | undefined): MigrationStockStatus {
  return value === "active" || value === "paused" ? value : "all";
}
