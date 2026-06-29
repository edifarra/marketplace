import { createClient } from "@supabase/supabase-js";
import { Sidebar } from "../components/sidebar";
import { saveIntegrationModeAction } from "./actions";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type MarketplaceAccount = {
  id: string;
  name: string;
  marketplace: string;
  account_id?: string | null;
  seller_id?: string | null;
  category_id?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  active: boolean;
};

export default async function IntegracoesPage() {
  const [{ data: settings }, { data: marketplaces }] = await Promise.all([
    supabase.from("settings").select("key,value").in("key", ["PRODUCT_SEND_TARGET", "TINY_TOKEN", "OLIST_TINY_COOKIE"]),
    supabase
      .from("config_marketplace_accounts")
      .select("id,name,marketplace,account_id,seller_id,category_id,access_token,refresh_token,active")
      .order("name")
  ]);

  const settingMap = new Map((settings ?? []).map((row) => [row.key, row.value]));
  const mode = String(settingMap.get("PRODUCT_SEND_TARGET") || "TINY");

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
          <h2>Marketplaces configurados</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Marketplace</th>
                  <th>Conta/Loja</th>
                  <th>Vinculo OAuth</th>
                  <th>Categoria</th>
                  <th>Status</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {((marketplaces ?? []) as MarketplaceAccount[]).map((account) => (
                  <tr key={account.id}>
                    <td>{account.name}</td>
                    <td>{account.marketplace}</td>
                    <td>{account.seller_id || account.account_id || "-"}</td>
                    <td>{account.access_token || account.refresh_token ? "Conectado" : "Nao conectado"}</td>
                    <td>{account.category_id || "-"}</td>
                    <td>{account.active ? "Ativo" : "Inativo"}</td>
                    <td>
                      <div className="row-actions">
                        {account.marketplace === "mercado_livre" ? (
                          <a className="secondary compact" href={`/api/mercado-livre/oauth/start?accountId=${encodeURIComponent(account.id)}`}>
                            {account.access_token || account.refresh_token ? "Reconectar Mercado Livre" : "Conectar Mercado Livre"}
                          </a>
                        ) : (
                          <span className="muted">Em breve</span>
                        )}
                        <a className="secondary compact" href={`/configuracoes/marketplace?edit=${encodeURIComponent(account.id)}`}>
                          Editar
                        </a>
                      </div>
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
