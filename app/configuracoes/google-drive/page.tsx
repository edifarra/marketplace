import {
  deleteGoogleDriveFolderAction,
  saveGoogleDriveFolderAction,
  saveGoogleDriveSettingsAction,
  testGoogleDriveConnectionAction
} from "./actions";
import { PendingSubmitButton } from "@/app/components/pending-submit-button";
import { Sidebar } from "@/app/components/sidebar";
import { getGoogleDriveConfigPageData } from "@/lib/google-drive-config";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: {
    q?: string;
    edit?: string;
    erro?: string;
  };
};

export default async function GoogleDriveConfigPage({ searchParams }: PageProps) {
  const {
    settings,
    folders,
    editFolder,
    setupError,
    testStatus,
    testResult,
    serverConnection
  } = await getGoogleDriveConfigPageData(searchParams?.q || "", searchParams?.edit);

  return (
    <main className="shell">
      <Sidebar />

      <section className="main">
        <div className="topbar">
          <div>
            <h1>Configuracoes: GoogleDrive</h1>
            <div className="subtitle">
              Configure a pasta Imagens e as pastas de origem ativas para a coleta via conexao Client Server.
            </div>
          </div>
        </div>

        {searchParams?.erro && <div className="form-error">{searchParams.erro}</div>}
        {setupError && <div className="form-error">{setupError}</div>}

        <section className="card form-card">
          <h2>Conexao Client Server Google Drive</h2>
          <div className="test-row">
            <div>
              <strong>{serverConnection.configured ? "Service Account configurada" : "Service Account nao configurada"}</strong>
              <div className="muted pipeline-result">
                Conta de servico: {serverConnection.clientEmail || "-"}.
              </div>
            </div>
          </div>
        </section>

        <section className="card form-card">
          <h2>Pasta Imagens e intervalo</h2>
          <form action={saveGoogleDriveSettingsAction} className="config-form">
            <div className="form-grid">
              <label>
                Pasta Drive Imagens
                <input
                  name="imagesFolderId"
                  required
                  defaultValue={settings.imagesFolderId || "1Uq5u6yDCMHcDm9EF2iQBqdUITap67aRu"}
                />
              </label>
              <label>
                Executar busca a cada:
                <span className="inline-field">
                  <input
                    name="intervalMinutes"
                    required
                    inputMode="numeric"
                    pattern="[0-9]+"
                    defaultValue={settings.intervalMinutes}
                  />
                  <span>Minutos</span>
                </span>
              </label>
            </div>
            <div className="form-actions">
              <button className="primary" type="submit">Salvar GoogleDrive</button>
            </div>
          </form>
          <div className="test-row">
            <form action={testGoogleDriveConnectionAction}>
              <PendingSubmitButton className="secondary" pendingLabel="Testando...">
                Testar Google Drive
              </PendingSubmitButton>
            </form>
            <div>
              <strong>{testStatus || "Teste ainda nao executado"}</strong>
              {testResult ? <div className="muted pipeline-result">{formatTestResult(testResult)}</div> : null}
            </div>
          </div>
        </section>

        <section className="section card form-card">
          <h2>{editFolder ? "Editar pasta auxiliar" : "Adicionar pasta auxiliar"}</h2>
          <form action={saveGoogleDriveFolderAction} className="config-form">
            {editFolder && <input type="hidden" name="originalId" value={editFolder.id} />}
            <div className="form-grid">
              <label>
                Nome
                <input name="name" required defaultValue={editFolder?.name || ""} placeholder="Ex: Pasta A" />
              </label>
              <label>
                ID da pasta
                <input name="folderId" required defaultValue={editFolder?.folder_id || ""} />
              </label>
              <label>
                Ativa
                <span className="check-row">
                  <input name="active" type="checkbox" defaultChecked={editFolder?.active ?? true} />
                  Buscar nesta pasta
                </span>
              </label>
            </div>
            <div className="form-actions">
              {editFolder && (
                <a className="secondary" href="/configuracoes/google-drive">
                  Cancelar edicao
                </a>
              )}
              <button className="primary" type="submit" disabled={Boolean(setupError)}>
                {editFolder ? "Salvar pasta" : "Adicionar pasta"}
              </button>
            </div>
          </form>
        </section>

        <section className="section card">
          <div className="table-toolbar">
            <div>
              <h2>Pastas auxiliares</h2>
              <div className="muted">
                {folders.length === 0
                  ? "Nenhuma pasta auxiliar definida. Cadastre ao menos uma pasta ativa para executar a coleta."
                  : `${folders.length} pasta(s) cadastrada(s).`}
              </div>
            </div>
            <form className="search-form" action="/configuracoes/google-drive">
              <input name="q" placeholder="Buscar pasta" defaultValue={searchParams?.q || ""} />
              <button className="secondary" type="submit">Buscar</button>
            </form>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>ID da pasta</th>
                  <th>Status</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                {folders.length === 0 ? (
                  <tr>
                    <td colSpan={4}>Nenhuma pasta auxiliar cadastrada.</td>
                  </tr>
                ) : (
                  folders.map((folder) => (
                    <tr key={folder.id}>
                      <td>{folder.name}</td>
                      <td>{folder.folder_id}</td>
                      <td>{folder.active ? "Ativa" : "Inativa"}</td>
                      <td>
                        <div className="row-actions">
                          <a className="secondary compact" href={`/configuracoes/google-drive?edit=${folder.id}`}>
                            Editar
                          </a>
                          <form action={deleteGoogleDriveFolderAction}>
                            <input type="hidden" name="id" value={folder.id} />
                            <button className="danger compact" type="submit">Excluir</button>
                          </form>
                        </div>
                      </td>
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

function formatTestResult(result: unknown) {
  if (!result || typeof result !== "object") {
    return "";
  }

  if ("error" in result) {
    return String(result.error);
  }

  const typed = result as {
    clientEmail?: string;
    totalFound?: number;
    totalValid?: number;
    folders?: Array<{ label: string; foundImages: number; validImages: number }>;
  };
  const folderSummary = typed.folders
    ?.map((folder) => `${folder.label}: ${folder.foundImages} imagem(ns), ${folder.validImages} valida(s)`)
    .join("; ") || "";

  return `Conta: ${typed.clientEmail || "-"}. Imagens: ${typed.totalFound ?? 0}. No padrao: ${typed.totalValid ?? 0}. ${folderSummary}.`;
}

