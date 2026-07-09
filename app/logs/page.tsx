import { Sidebar } from "../components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type PipelineRun = {
  id: string;
  status: string;
  stage: string;
  metrics: unknown;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type ProductLogItem = {
  fileName?: string;
  sourceKey?: string;
  stage?: string;
  status?: string;
  reason?: string;
  variables?: Record<string, unknown>;
};

export default async function LogsPage() {
  const supabase = supabaseAdmin();
  const { data: runs } = await supabase
    .from("pipeline_runs")
    .select("id,status,stage,metrics,error_message,started_at,finished_at,created_at")
    .in("stage", ["product_load", "drive_collect"])
    .order("created_at", { ascending: false })
    .limit(12)
    .throwOnError();

  const typedRuns = (runs ?? []) as PipelineRun[];

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Logs</h1>
            <div className="subtitle">Detalhes das ultimas execucoes do Google Drive e do carregamento de produtos.</div>
          </div>
        </div>

        <section className="section card">
          <h2>Execucoes recentes</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Processo</th>
                  <th>Status</th>
                  <th>Resumo</th>
                </tr>
              </thead>
              <tbody>
                {typedRuns.map((run) => (
                  <tr key={run.id}>
                    <td>{formatDate(run.finished_at || run.started_at || run.created_at)}</td>
                    <td>{stageLabel(run.stage)}</td>
                    <td><span className="status">{statusLabel(run.status)}</span></td>
                    <td>{summaryForRun(run)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {typedRuns.filter((run) => run.stage === "product_load").map((run) => (
          <section className="section card" key={`details-${run.id}`}>
            <h2>Carregamento de produtos - {formatDate(run.finished_at || run.started_at || run.created_at)}</h2>
            {run.error_message ? <div className="form-error">{run.error_message}</div> : null}
            <ProductRunDetails run={run} />
          </section>
        ))}
      </section>
    </main>
  );
}

function ProductRunDetails({ run }: { run: PipelineRun }) {
  const products = getProductsMetrics(run.metrics);
  const logs = products.itemLogs;
  const importantLogs = logs.filter((item) => item.status && item.status !== "avaliado");

  if (importantLogs.length === 0) {
    return <div className="muted">Nenhum descarte, duplicidade ou falha registrada nesta execucao.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Resultado</th>
            <th>Etapa</th>
            <th>Motivo</th>
            <th>Detalhes</th>
          </tr>
        </thead>
        <tbody>
          {importantLogs.map((item, index) => (
            <tr key={`${run.id}-${index}`}>
              <td>
                <strong>{item.sourceKey || item.fileName || "-"}</strong>
                {item.fileName && item.sourceKey ? <div className="muted">{item.fileName}</div> : null}
              </td>
              <td>{item.status || "-"}</td>
              <td>{item.stage || "-"}</td>
              <td>{item.reason || reasonFromVariables(item.variables) || "-"}</td>
              <td><code className="log-code">{shortDetails(item.variables)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function getProductsMetrics(metrics: unknown) {
  const products = metrics && typeof metrics === "object" && "products" in metrics
    ? (metrics as { products?: Record<string, unknown> }).products
    : undefined;

  return {
    created: Number(products?.created || 0),
    duplicates: Number(products?.duplicates || 0),
    discarded: Number(products?.discarded || 0),
    failed: Number(products?.failed || 0),
    itemLogs: Array.isArray(products?.itemLogs) ? products.itemLogs as ProductLogItem[] : []
  };
}

function summaryForRun(run: PipelineRun) {
  if (run.stage === "product_load") {
    const products = getProductsMetrics(run.metrics);
    return `Criados: ${products.created}; duplicados: ${products.duplicates}; descartados: ${products.discarded}; falhas: ${products.failed}.`;
  }

  const drive = run.metrics && typeof run.metrics === "object" && "drive" in run.metrics
    ? (run.metrics as { drive?: Record<string, unknown> }).drive
    : undefined;

  return String(drive?.message || run.error_message || "Sem resumo.");
}

function stageLabel(stage: string) {
  return stage === "product_load" ? "Carregamento de Produtos" : "Google Drive";
}

function statusLabel(status: string) {
  if (status === "done") {
    return "Executado";
  }

  if (status === "running") {
    return "Executando";
  }

  return "Erro";
}

function reasonFromVariables(value?: Record<string, unknown>) {
  if (!value) {
    return "";
  }

  if (typeof value.existingSku === "string") {
    return `Produto ja cadastrado no SKU ${value.existingSku}`;
  }

  if (value.typeFound === false) {
    return `Tipo ${String(value.typeCode || "")} nao cadastrado`;
  }

  if (value.brandFound === false) {
    return `Marca ${String(value.brandCode || "")} nao cadastrada`;
  }

  return "";
}

function shortDetails(value?: Record<string, unknown>) {
  if (!value) {
    return "-";
  }

  const entries = Object.entries(value)
    .filter(([key]) => !["knownTypeCodes", "knownBrandCodes", "photos"].includes(key))
    .slice(0, 6);

  return entries.map(([key, item]) => `${key}: ${formatValue(item)}`).join("; ") || "-";
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value ?? "");
}

function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short"
  });
}
