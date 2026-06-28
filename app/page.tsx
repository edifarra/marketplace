import { createClient } from "@supabase/supabase-js";
import { PipelineProgressButton } from "./components/pipeline-progress-button";
import { ProductLoadButton } from "./components/product-load-button";
import { Sidebar } from "./components/sidebar";
import { hasGoogleDriveConfig } from "@/lib/google-drive";
import { getGoogleDriveSettings } from "@/lib/google-drive-config";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default async function HomePage() {
  const { count: activeProducts } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");

  const { count: zeroStock } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("stock", 0);

  const { count: waitingProducts } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .in("status", ["draft", "ready", "publishing"]);

  const { count: errorProducts } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("status", "error");

  const { data: lastDriveRun } = await supabase
    .from("pipeline_runs")
    .select("status, metrics, error_message, finished_at")
    .eq("stage", "drive_collect")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const { data: lastProductLoadRun } = await supabase
    .from("pipeline_runs")
    .select("status, metrics, error_message, finished_at")
    .eq("stage", "product_load")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const { data: lastBatchSend } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "PRODUCT_SEND_BATCH_LAST_RESULT")
    .maybeSingle();

  const driveConfigured = await hasGoogleDriveConfig();
  const driveSettings = await getGoogleDriveSettings();

  return (
    <main className="shell">
      <Sidebar />

      <section className="main">
        <div className="topbar" id="dashboard">
          <div>
            <h1>Controle de estoque e anuncios</h1>
            <div className="subtitle">
              Do Google Drive ao Mercado Livre e Shopee, com estoque centralizado no Supabase.
            </div>
          </div>
        </div>

        <section className="grid metrics">
          <Metric label="Produtos ativos" value={String(activeProducts ?? 0)} />
          <Metric label="Estoque zerado" value={String(zeroStock ?? 0)} />
          <Metric label="Aguardando envio" value={String(waitingProducts ?? 0)} />
          <Metric label="Erros para revisar" value={String(errorProducts ?? 0)} />
        </section>

        <section className="section card" id="pipeline">
          <h2>Etapas do Processamento</h2>
          <table>
            <thead>
              <tr>
                <th>Etapa</th>
                <th>Processamento</th>
                <th>Resultado</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Google Drive</td>
                <td>Busca imagens validas e ignora duplicadas</td>
                <td>
                  <span className="status">{driveStatusLabel(lastDriveRun?.status, driveConfigured)}</span>
                  <div className="muted pipeline-result">
                    {formatDriveResult(lastDriveRun, driveSettings.intervalMinutes)}
                  </div>
                </td>
                <td>
                  <PipelineProgressButton
                    endpoint="/api/pipeline/run?force=1"
                    progressEndpoint="/api/pipeline/drive/progress"
                    idleLabel="Executar Agora"
                    runningLabel="Processando..."
                    disabled={!driveConfigured}
                  />
                </td>
              </tr>
              <tr>
                <td>Carregamento de Produtos</td>
                <td>Usa Tipo, Marca, Especial, Preco e MarketPlace</td>
                <td>
                  <span className="status">{pipelineStatusLabel(lastProductLoadRun?.status)}</span>
                  <div className="muted pipeline-result">
                    {formatProductLoadResult(lastProductLoadRun)}
                  </div>
                </td>
                <td>
                  <ProductLoadButton />
                </td>
              </tr>
              <tr>
                <td>Enviar Produtos em Lote</td>
                <td>Envia todos os produtos pendentes para a integracao marcada</td>
                <td>
                  <span className="status">Pronto para envio</span>
                  <div className="muted pipeline-result">
                    {formatBatchSendResult(lastBatchSend?.value)}
                  </div>
                </td>
                <td>
                  <PipelineProgressButton
                    endpoint="/api/products/send-batch"
                    progressEndpoint="/api/products/send-batch/progress"
                    idleLabel="Executar Agora"
                    runningLabel="Enviando..."
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="section card" id="integracoes">
          <h2>Integracoes</h2>
          <table>
            <thead>
              <tr>
                <th>Servico</th>
                <th>Status</th>
                <th>Origem</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Supabase</td>
                <td><span className="status">Conectado</span></td>
                <td>Tabelas products, listings e configuracoes</td>
              </tr>
              <tr>
                <td>Mercado Livre</td>
                <td><span className="status">Draft</span></td>
                <td>Anuncios criados em listings antes do envio</td>
              </tr>
              <tr>
                <td>Shopee</td>
                <td><span className="status">Draft</span></td>
                <td>Anuncios criados em listings antes do envio</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function driveStatusLabel(status: string | null | undefined, configured: boolean) {
  if (!configured) {
    return "Configurar credenciais";
  }

  if (!status) {
    return "Aguardando primeira execucao";
  }

  return status === "done" ? "Executado" : "Erro na ultima execucao";
}

function pipelineStatusLabel(status: string | null | undefined) {
  if (!status) {
    return "Aguardando primeira execucao";
  }

  return status === "done" ? "Executado" : "Erro na ultima execucao";
}

function formatDriveResult(run: { status: string; metrics: unknown; error_message: string | null; finished_at: string | null } | null, intervalMinutes: number) {
  if (!run?.finished_at) {
    return `Ultima execucao: ainda nao executado. Intervalo configurado: ${intervalMinutes} minuto(s).`;
  }

  const date = new Date(run.finished_at).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short"
  });

  if (run.status !== "done") {
    return `Ultima execucao: ${date}. Erro: ${run.error_message || "nao informado"}. Proxima tentativa em ${intervalMinutes} minuto(s).`;
  }

  const drive = extractDriveMetrics(run.metrics);
  if (!drive) {
    return `Ultima execucao: ${date}.`;
  }

  return `Ultima execucao: ${date}. Imagens encontradas: ${drive.totalFound}; no padrao: ${drive.totalValid}; movidas: ${drive.totalMoved}; copiadas: ${drive.totalCopied}; falhas: ${drive.totalFailed}.`;
}

function extractDriveMetrics(metrics: unknown) {
  if (!metrics || typeof metrics !== "object" || !("drive" in metrics)) {
    return null;
  }

  const drive = (metrics as { drive?: Record<string, unknown> }).drive;
  if (!drive) {
    return null;
  }

  return {
    totalFound: Number(drive.totalFound || 0),
    totalValid: Number(drive.totalValid || 0),
    totalMoved: Number(drive.totalMoved || 0),
    totalCopied: Number(drive.totalCopied || 0),
    totalFailed: Number(drive.totalFailed || 0)
  };
}

function formatProductLoadResult(run: { status: string; metrics: unknown; error_message: string | null; finished_at: string | null } | null) {
  if (!run?.finished_at) {
    return "Ultima execucao: ainda nao executado.";
  }

  const date = new Date(run.finished_at).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short"
  });

  if (run.status !== "done" && !run.metrics) {
    return `Ultima execucao: ${date}. Erro: ${run.error_message || "nao informado"}.`;
  }

  const products = extractProductLoadMetrics(run.metrics);
  if (!products) {
    return `Ultima execucao: ${date}.`;
  }

  return `Ultima execucao: ${date}. Produtos Criados: ${products.created}; Duplicados: ${products.duplicates}; Descartados: ${products.discarded}; falhas: ${products.failed}.`;
}

function extractProductLoadMetrics(metrics: unknown) {
  if (!metrics || typeof metrics !== "object" || !("products" in metrics)) {
    return null;
  }

  const products = (metrics as { products?: Record<string, unknown> }).products;
  if (!products) {
    return null;
  }

  return {
    created: Number(products.created || 0),
    duplicates: Number(products.duplicates || 0),
    discarded: Number(products.discarded || 0),
    failed: Number(products.failed || 0)
  };
}

function formatBatchSendResult(value: unknown) {
  if (!value || typeof value !== "object") {
    return "Ultima execucao: ainda nao executado.";
  }

  const result = value as Record<string, unknown>;
  const finishedAt = result.finishedAt ? new Date(String(result.finishedAt)) : null;
  const date = finishedAt
    ? finishedAt.toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short"
      })
    : "data nao informada";

  return `Ultima execucao: ${date}. Pendentes avaliados: ${Number(result.total || 0)}; enviados: ${Number(result.sent || 0)}; falhas: ${Number(result.failed || 0)}.`;
}
