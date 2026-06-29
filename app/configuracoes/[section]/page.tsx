import { deleteConfigurationAction, saveConfigurationAction } from "../actions";
import { Sidebar } from "@/app/components/sidebar";
import {
  ConfigSection,
  formatValue,
  getConfigurationPageData,
  isConfigSection
} from "@/lib/configurations";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type PageProps = {
  params: {
    section: string;
  };
  searchParams?: {
    q?: string;
    edit?: string;
    erro?: string;
  };
};

type ConfigurationPageData = Awaited<ReturnType<typeof getConfigurationPageData>>;

export default async function ConfigurationSectionPage({ params, searchParams }: PageProps) {
  if (!isConfigSection(params.section)) {
    notFound();
  }

  const section = params.section as ConfigSection;
  const data = await getConfigurationPageData(section, searchParams?.q || "", searchParams?.edit);
  const { definition } = data;
  const marketplaceFirst = section === "marketplace";

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

        {marketplaceFirst ? (
          <>
            <ConfigurationTable section={section} data={data} searchQuery={searchParams?.q || ""} />
            <ConfigurationForm section={section} data={data} />
          </>
        ) : (
          <>
            <ConfigurationForm section={section} data={data} />
            <ConfigurationTable section={section} data={data} searchQuery={searchParams?.q || ""} />
          </>
        )}
      </section>
    </main>
  );
}

function ConfigurationForm({ section, data }: { section: ConfigSection; data: ConfigurationPageData }) {
  const { definition, editRow } = data;

  return (
    <section className={section === "marketplace" ? "section card form-card" : "card form-card"}>
      <h2>{editRow ? "Editar configuracao" : "Adicionar nova configuracao"}</h2>
      <form action={saveConfigurationAction} className="config-form">
        <input type="hidden" name="section" value={section} />
        {editRow && <input type="hidden" name="originalKey" value={String(editRow[definition.keyField])} />}

        <div className="form-grid">
          {definition.fields.map((field) => (
            <label key={field.name} className={field.type === "textarea" ? "wide-field" : undefined}>
              {field.label}
              {field.type === "textarea" ? (
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
                    defaultChecked={Boolean(editRow?.[field.name])}
                  />
                  Ativo
                </span>
              ) : (
                <input
                  name={field.name}
                  required={field.required}
                  type={field.type === "number" ? "number" : "text"}
                  step={field.type === "number" ? "0.001" : undefined}
                  defaultValue={editRow ? editValue(editRow[field.name]) : ""}
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
                <th key={field}>{labelize(field)}</th>
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
                          formatValue(row[field])
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
                          <form action={deleteConfigurationAction}>
                            <input type="hidden" name="section" value={section} />
                            <input type="hidden" name="key" value={key} />
                            <button className="danger compact" type="submit">
                              Excluir
                            </button>
                          </form>
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
