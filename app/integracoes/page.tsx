import { createClient } from "@supabase/supabase-js";
import { Sidebar } from "../components/sidebar";
import { removeMarketplaceAccountAction, saveIntegrationModeAction, syncMarketplaceAccountAction } from "./actions";
import { listMarketplaceAccountViews } from "@/lib/marketplace-accounts-view";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type IntegracoesPageProps = {
  searchParams?: {
    erro?: string;
  };
};

export default async function IntegracoesPage({ searchParams }: IntegracoesPageProps) {
  noStore();

  const [{ data: settings }, marketplaces] = await Promise.all([
    supabase.from("settings").select("key,value").in("key", ["PRODUCT_SEND_TARGET", "TINY_TOKEN", "OLIST_TINY_COOKIE"]),
    listMarketplaceAccountViews()
  ]);

  const settingMap = new Map((settings ?? []).map((row) => [row.key, row.value]));
  const mode = String(settingMap.get("PRODUCT_SEND_TARGET") || "TINY");
  const errorMessage = searchParams?.erro || "";

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Integracoes</h1>
            <div className="subtitle">Defina se o produto sera enviado ao Tiny ou diretamente aos marketplaces.</div>
          </div>
        </div>

        {errorMessage && <div className="form-error">{errorMessage}</div>}

        <section className="card form-card">
          <h2>Destino de envio</h2>
          <form action={saveIntegrationModeAction} className="config-form">
            <label className="option-row">
              <input type="radio" name="mode" value="tiny" defaultChecked={mode !== "MARKETPLACE_DIRETO"} />
              Enviar produto ao Tiny
            </label>
            <label className="option-row">
              <input type="radio" name="mode" value="marketplace" defaultChecked={mode === "MARKETPLACE_DIRETO"} />
              Enviar produto diretamente ao MarketPlace
            </label>
            <div className="form-actions">
              <a className="secondary" href="/configuracoes/tiny">Configurar Tiny</a>
              <a className="secondary" href="/configuracoes/marketplace">Configurar Marketplaces</a>
              <button className="primary" type="submit">Salvar opcao</button>
            </div>
          </form>
        </section>

        <section className="section card">
          <div className="table-toolbar">
            <div>
              <h2>Contas conectadas</h2>
              <p className="muted">
                Para conectar outra conta do Mercado Livre, use uma guia anonima ou saia da conta atual antes de continuar.
                Depois da conexao, o refresh token salvo nessa conta sera usado automaticamente.
              </p>
            </div>
            <div className="row-actions">
              <a className="primary compact" href="/configuracoes/marketplace?novo=mercado_livre#marketplace-config-form">Adicionar Conta Mercado Livre</a>
              <a className="primary compact" href="/configuracoes/marketplace?novo=shopee#marketplace-config-form">Adicionar Conta Shopee</a>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Marketplace</th>
                  <th>Nome da conta</th>
                  <th>Seller/Shop ID</th>
                  <th>Nickname</th>
                  <th>Email</th>
                  <th>Status conexao</th>
                  <th>Ultima sync</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {marketplaces.map((account) => (
                  <tr key={account.id}>
                    <td>{account.marketplace}</td>
                    <td>{account.name}</td>
                    <td>{account.seller_id || account.shop_id || account.account_id || "-"}</td>
                    <td>{account.nickname || "-"}</td>
                    <td>{account.email || "-"}</td>
                    <td>{account.status || "-"}</td>
                    <td>{account.last_sync_at || account.last_inventory_sync_at || "-"}</td>
                    <td>
                      <div className="row-actions">
                        <form action={syncMarketplaceAccountAction}>
                          <input type="hidden" name="accountId" value={account.id} />
                          <button className="secondary compact" type="submit">Sincronizar</button>
                        </form>
                        {account.marketplace === "mercado_livre" && (
                          <a className="secondary compact" href={`/api/mercado-livre/oauth/start?accountId=${encodeURIComponent(account.id)}`}>
                            {account.access_token || account.refresh_token ? "Reconectar Mercado Livre" : "Conectar Mercado Livre"}
                          </a>
                        )}
                        {account.marketplace === "shopee" && (
                          <a className="secondary compact" href={`/api/shopee/oauth/start?accountId=${encodeURIComponent(account.id)}`}>
                            {account.access_token || account.refresh_token ? "Reconectar Shopee" : "Conectar Shopee"}
                          </a>
                        )}
                        <a className="secondary compact" href={`/configuracoes/marketplace?edit=${encodeURIComponent(account.id)}`}>
                          Editar
                        </a>
                        <form action={removeMarketplaceAccountAction}>
                          <input type="hidden" name="accountId" value={account.id} />
                          <button className="danger compact" type="submit">Remover</button>
                        </form>
                      </div>
                      {account.last_error && <div className="muted">{account.last_error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section card">
          <h2>Tiny</h2>
          <p className="muted">
            Configure `TINY_TOKEN` e `OLIST_TINY_COOKIE` em Configuracoes &gt; Tiny. O envio de produto usa a API
            `produto.incluir.php`, conforme o script anterior.
          </p>
        </section>
      </section>
    </main>
  );
}
