import { deleteConfigurationAction, saveConfigurationAction } from "../actions";
import { Sidebar } from "@/app/components/sidebar";
import {
  ConfigSection,
  formatValue,
  getConfigurationPageData,
  isConfigSection
} from "@/lib/configurations";
import { formatMarketplaceDateTime, marketplaceDisplayStatus } from "@/lib/marketplace-accounts-view";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { TypeConfiguration } from "../type-configuration";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type PageProps = {
  params: {
    section: string;
  };
  searchParams?: {
    q?: string;
    edit?: string;
    erro?: string;
    novo?: string;
    sucesso?: string;
  };
};

type ConfigurationPageData = Awaited<ReturnType<typeof getConfigurationPageData>>;

export default async function ConfigurationSectionPage({ params, searchParams }: PageProps) {
  noStore();

  if (!isConfigSection(params.section)) {
    notFound();
  }

  const section = params.section as ConfigSection;
  const data = await getConfigurationPageData(section, searchParams?.q || "", searchParams?.edit);
  const { definition } = data;
  const marketplaceFirst = section === "marketplace";
  const newMarketplace = normalizeNewMarketplace(searchParams?.novo);

  if (section === "tipo") {
    const mappings = await supabaseAdmin().from("marketplace_category_mappings").select("*").order("internal_category").throwOnError();
    return <main className="shell"><Sidebar/><section className="main"><div className="topbar"><div><h1>Configurações: Tipo</h1><div className="subtitle">Tipos, categorias, atributos, medidas e templates.</div></div></div>
      {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}{searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
      <TypeConfiguration rows={data.rows} mappings={(mappings.data || []) as any} editRow={data.editRow} showForm={Boolean(data.editRow || searchParams?.novo)}/>
    </section></main>;
  }

  return (
    <main className="shell">
      <Sidebar />

      <section className="main">
        <div className="topbar">
          <div>
            <h1>Configuracoes: {definition.title}</h1>
            <div className="subtitle">{definition.description}</div>
          </div>
        </div>

        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {searchParams?.sucesso && <div className="form-success">{searchParams.sucesso}</div>}
        {section === "marketplace" && (
          <section className="card form-card">
            <h2>Conectar nova conta</h2>
            <p className="muted">
              Para conectar outra conta do Mercado Livre, use uma guia anonima ou saia da conta atual antes de continuar.
            </p>
            <div className="form-actions">
              <a className="primary" href="/configuracoes/marketplace?novo=mercado_livre#marketplace-config-form">Adicionar Conta Mercado Livre</a>
              <a className="primary" href="/configuracoes/marketplace?novo=shopee#marketplace-config-form">Adicionar Conta Shopee</a>
            </div>
          </section>
        )}

        {section === "config-geral" ? (
          <GeneralConfigurationTable data={data} />
        ) : section === "preco" ? (
          <>
            {data.editRow && <ConfigurationForm section={section} data={data} newMarketplace={newMarketplace} />}
            <PriceConfigurationGroups data={data} />
          </>
        ) : marketplaceFirst ? (
          <>
            <ConfigurationTable section={section} data={data} searchQuery={searchParams?.q || ""} />
            <ConfigurationForm section={section} data={data} newMarketplace={newMarketplace} />
          </>
        ) : (
          <>
            <ConfigurationForm section={section} data={data} newMarketplace={newMarketplace} />
            <ConfigurationTable section={section} data={data} searchQuery={searchParams?.q || ""} />
          </>
        )}
      </section>
    </main>
  );
}

function GeneralConfigurationTable({ data }: { data: ConfigurationPageData }) {
  const labels: Record<string, { title: string; description: string }> = {
    ESTOQUE_INICIAL: { title: "Estoque inicial", description: "Quantidade inicial aplicada ao criar um produto." },
    CARREGAMENTO_PRODUTOS_AUTOMATICO: { title: "Carregamento automático de produtos", description: "Carrega produtos automaticamente após encontrar novas fotos no Google Drive." },
    ENVIAR_PRODUTOS_AUTOMATICO: { title: "Envio automático de produtos", description: "Envia automaticamente os produtos aprovados pelas regras de preço ao destino definido em Integrações." }
  };
  return <section className="card">
    <div className="table-toolbar"><div><h2>Configurações gerais</h2><p className="muted">Parâmetros obrigatórios do fluxo de produtos.</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Parâmetro</th><th>Valor</th><th>Descrição</th><th>Ação</th></tr></thead><tbody>
      {data.rows.map((row) => {
        const key = String(row.key || "");
        const item = labels[key] || { title: key, description: String(row.description || "") };
        const current = String(row.value ?? "").toUpperCase();
        return <tr key={key}>
          <td><strong>{item.title}</strong><small>{key}</small></td>
          <td colSpan={2}>
            <form action={saveConfigurationAction} className="inline-edit-form">
              <input type="hidden" name="section" value="config-geral" />
              <input type="hidden" name="originalKey" value={key} />
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="description" value={`[CONFIG_GERAL] ${item.description}`} />
              {key === "ESTOQUE_INICIAL" ? (
                <input aria-label={item.title} name="value" type="number" min="0" step="1" required defaultValue={String(row.value ?? 0)} />
              ) : (
                <select aria-label={item.title} name="value" required defaultValue={current === "SIM" ? "SIM" : "NÃO"}>
                  <option value="SIM">SIM</option><option value="NÃO">NÃO</option>
                </select>
              )}
              <span className="muted">{item.description}</span>
              <button className="primary compact" type="submit">Salvar</button>
            </form>
          </td>
          <td><span className="muted">Obrigatória</span></td>
        </tr>;
      })}
    </tbody></table></div>
  </section>;
}

function ConfigurationForm({
  section,
  data,
  newMarketplace
}: {
  section: ConfigSection;
  data: ConfigurationPageData;
  newMarketplace: "mercado_livre" | "shopee" | "";
}) {
  const { definition, editRow } = data;
  const marketplace = section === "marketplace"
    ? normalizeNewMarketplace(String(editRow?.marketplace || newMarketplace))
    : "";

  if (section === "marketplace" && !marketplace) {
    return (
      <section id="marketplace-config-form" className="section card form-card">
        <h2>Configurar credenciais</h2>
        <p className="muted">Escolha Mercado Livre ou Shopee acima para exibir somente os campos daquela integracao.</p>
      </section>
    );
  }

  const fields = section === "marketplace"
    ? marketplaceConfigurationFields(definition.fields, marketplace)
    : definition.fields;

  return (
    <section id={section === "marketplace" ? "marketplace-config-form" : undefined} className={section === "marketplace" ? "section card form-card" : "card form-card"}>
      <h2>{editRow ? "Editar configuracao" : "Adicionar nova configuracao"}</h2>
      <form action={saveConfigurationAction} className="config-form">
        <input type="hidden" name="section" value={section} />
        {editRow && <input type="hidden" name="originalKey" value={String(editRow[definition.keyField])} />}
        {section === "marketplace" && <input type="hidden" name="marketplace" value={marketplace} />}

        <div className="form-grid">
          {fields.map((field) => (
            <label key={field.name} className={["textarea", "json"].includes(field.type) ? "wide-field" : undefined}>
              {field.label}
              {["textarea", "json"].includes(field.type) ? (
                <textarea
                  name={field.name}
                  required={field.required}
                  defaultValue={editRow ? editValue(editRow[field.name]) : ""}
                />
              ) : field.type === "checkbox" ? (
                <span className="check-row">
                  <input
                    name={field.name}
                  type="checkbox"
                  defaultChecked={editRow ? Boolean(editRow[field.name]) : section === "marketplace" && field.name === "active"}
                />
                Ativo
              </span>
              ) : (
                <input
                  name={field.name}
                  required={field.required}
                  readOnly={section === "preco" && field.name === definition.keyField}
                  type={field.type === "number" ? "number" : "text"}
                  step={field.type === "number" ? "0.001" : undefined}
                  defaultValue={editRow ? editValue(editRow[field.name]) : defaultNewValue(section, newMarketplace, field.name)}
                />
              )}
            </label>
          ))}
        </div>

        <div className="form-actions">
          {editRow && (
            <a className="secondary" href={`/configuracoes/${section}`}>
              Cancelar edicao
            </a>
          )}
          <button className="primary" type="submit">
            {editRow ? "Salvar alteracoes" : "Adicionar"}
          </button>
        </div>
      </form>
    </section>
  );
}

const priceGroups = [
  {
    title: "Elegibilidade",
    description: "Define quantos anúncios serão buscados e quais palavras eliminam um anúncio da avaliação.",
    keys: ["QUANTIDADE_ANUNCIOS_RECUPERADOS", "PALAVRAS_NEGADAS"]
  },
  {
    title: "Validação de Anúncios para Cálculo",
    description: "Seleciona quantos anúncios válidos entram no cálculo. VALORES_EM_GAP é a quantidade mínima de anúncios válidos exigida; abaixo dela o preço será marcado para Verificação Manual.",
    keys: ["QUANTIDADE_ANUNCIOS_PARA_CALCULO", "PERCENTUAL_OUTLIER_INFERIOR", "VALORES_EM_GAP"]
  },
  {
    title: "Definições de Preço",
    description: "Define a referência do preço e as cinco faixas com arredondamento e deflator próprios.",
    keys: ["DEFINICAO_PRECO", "TIPO_DEFLATOR", "VALOR_DEPLATOR", "FAIXA_DEFLATOR_1", "FAIXA_DEFLATOR_2", "FAIXA_DEFLATOR_3", "FAIXA_DEFLATOR_4", "FAIXA_DEFLATOR_5"]
  }
] as const;

function PriceConfigurationGroups({ data }: { data: ConfigurationPageData }) {
  const rowsByKey = new Map(data.rows.map((row) => [String(row.key || ""), row]));
  return <div className="price-config-groups">
    {priceGroups.map((group) => <section className="section card" key={group.title}>
      <div className="price-config-heading"><h2>{group.title}</h2><p className="muted">{group.description}</p></div>
      <div className="table-wrap"><table className="price-config-table"><thead><tr><th>Parâmetro</th><th>Valor</th><th>Descrição</th><th>Ação</th></tr></thead><tbody>
        {group.keys.map((key) => {
          const row = rowsByKey.get(key) || { key, value: "", description: "Parâmetro ainda não configurado.", __virtual: true };
          return <tr key={key}>
            <td><strong>{priceParameterLabel(key)}</strong><small>{key}</small></td>
            <td><code>{formatValue(row.value)}</code></td>
            <td>{String(row.description || "-").replace("[PRECO]", "").trim()}</td>
            <td><a className="secondary compact" href={`/configuracoes/preco?edit=${encodeURIComponent(key)}`}>Editar</a></td>
          </tr>;
        })}
      </tbody></table></div>
    </section>)}
  </div>;
}

function priceParameterLabel(key: string) {
  const labels: Record<string, string> = {
    QUANTIDADE_ANUNCIOS_RECUPERADOS: "Quantidade de anúncios recuperados",
    PALAVRAS_NEGADAS: "Palavras excluídas",
    QUANTIDADE_ANUNCIOS_PARA_CALCULO: "Quantidade de anúncios para cálculo",
    PERCENTUAL_OUTLIER_INFERIOR: "Percentual de outlier inferior",
    VALORES_EM_GAP: "Quantidade mínima de anúncios válidos",
    DEFINICAO_PRECO: "Definição do preço",
    TIPO_DEFLATOR: "Tipo de deflator padrão",
    VALOR_DEPLATOR: "Valor do deflator padrão"
  };
  return labels[key] || key.replace("FAIXA_DEFLATOR_", "Faixa do deflator ");
}

function ConfigurationTable({
  section,
  data,
  searchQuery
}: {
  section: ConfigSection;
  data: ConfigurationPageData;
  searchQuery: string;
}) {
  const { definition, rows } = data;

  return (
    <section className={section === "marketplace" ? "card" : "section card"}>
      <div className="table-toolbar">
        <div>
          <h2>Configuracoes existentes</h2>
          <div className="muted">{rows.length} registro(s) encontrado(s)</div>
        </div>
        <form className="search-form" action={`/configuracoes/${section}`}>
          <input name="q" placeholder="Buscar configuracao" defaultValue={searchQuery} />
          <button className="secondary" type="submit">Buscar</button>
        </form>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {definition.listFields.map((field) => (
                <th key={field}>{definition.fields.find((item) => item.name === field)?.label || labelize(field)}</th>
              ))}
              <th>Acoes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={definition.listFields.length + 1}>Nenhuma configuracao encontrada.</td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const key = String(row[definition.keyField] || "");
                const hasValidKey = key && key !== "undefined" && key !== "null";
                const isVirtualSetting = row.__virtual === true;
                const rowKey = hasValidKey ? key : `row-${index}`;

                return (
                  <tr key={rowKey}>
                    {definition.listFields.map((field) => (
                      <td key={field}>
                        {section === "sku" && field === "current_number" && hasValidKey ? (
                          <form action={saveConfigurationAction} className="inline-edit-form">
                            <input type="hidden" name="section" value={section} />
                            <input type="hidden" name="originalKey" value={key} />
                            <input type="hidden" name="sku_group" value={key} />
                            <input name="current_number" type="number" defaultValue={editValue(row[field])} />
                            <button className="secondary compact" type="submit">Salvar</button>
                          </form>
                        ) : (
                          formatTableValue(section, field, row)
                        )}
                      </td>
                    ))}
                    <td>
                      {hasValidKey ? (
                        <div className="row-actions">
                          <a className="secondary compact" href={`/configuracoes/${section}?edit=${encodeURIComponent(key)}`}>
                            Editar
                          </a>
                          {section === "marketplace" && row.marketplace === "mercado_livre" && (
                            <a className="secondary compact" href={`/api/mercado-livre/oauth/start?accountId=${encodeURIComponent(key)}`}>
                              {row.access_token || row.refresh_token ? "Reconectar ML" : "Conectar ML"}
                            </a>
                          )}
                          {section === "marketplace" && row.marketplace === "shopee" && (
                            <a className="secondary compact" href={`/api/shopee/oauth/start?accountId=${encodeURIComponent(key)}`}>
                              {row.access_token || row.refresh_token ? "Reconectar Shopee" : "Conectar Shopee"}
                            </a>
                          )}
                          {section === "preco" ? null : isVirtualSetting ? (
                            <span className="muted compact-label">Sem valor salvo</span>
                          ) : (
                            <form action={deleteConfigurationAction}>
                              <input type="hidden" name="section" value={section} />
                              <input type="hidden" name="key" value={key} />
                              <button className="danger compact" type="submit">
                                Excluir
                              </button>
                            </form>
                          )}
                        </div>
                      ) : (
                        <span className="muted">Registro sem id</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function editValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function labelize(field: string) {
  return field.replace(/_/g, " ");
}

function formatTableValue(section: ConfigSection, field: string, row: Record<string, unknown>) {
  if (section === "marketplace" && field === "status") {
    return marketplaceDisplayStatus(row);
  }

  if (section === "marketplace" && ["last_sync_at", "last_inventory_sync_at", "token_expires_at"].includes(field)) {
    return formatMarketplaceDateTime(row[field]);
  }

  return formatValue(row[field]);
}

function normalizeNewMarketplace(value?: string) {
  return value === "mercado_livre" || value === "shopee" ? value : "";
}

function defaultNewValue(section: ConfigSection, marketplace: "mercado_livre" | "shopee" | "", field: string) {
  if (section !== "marketplace" || !marketplace) {
    return "";
  }

  if (field === "marketplace") {
    return marketplace;
  }

  if (field === "name") {
    return marketplace === "mercado_livre" ? "Mercado Livre" : "Shopee";
  }

  return "";
}

function marketplaceConfigurationFields(
  fields: ConfigurationPageData["definition"]["fields"],
  marketplace: "mercado_livre" | "shopee" | ""
) {
  const common = new Set([
    "name",
    "category_id",
    "client_id",
    "client_secret",
    "redirect_uri",
    "active"
  ]);

  if (marketplace === "shopee") {
    common.add("api_base_url");
  }

  return fields.filter((field) => common.has(field.name));
}
