import { Sidebar } from "../components/sidebar";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { LogGrid, type LogGridRow } from "./log-grid";

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

type PipelineLog = {
  id: string;
  message: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export default async function LogsPage() {
  const [runs, logs] = await Promise.all([
    getAllPipelineRuns(),
    getAllPipelineLogs()
  ]);

  const pipelineRows = runs.map(runToGridRow);
  const synchronizationRows = logs
    .filter((log) => log.payload?.stage === "stock_sync")
    .map(syncLogToGridRow);
  const rows = [...synchronizationRows, ...pipelineRows]
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate))
    .map(({ sortDate: _sortDate, ...row }) => row);

  return (
    <main className="shell">
      <Sidebar />
      <section className="main">
        <div className="topbar">
          <div>
            <h1>Logs</h1>
            <div className="subtitle">Histórico das sincronizações e dos processos do sistema.</div>
          </div>
        </div>

        <section className="section card">
          <div className="table-toolbar">
            <div>
              <h2>Execuções recentes</h2>
              <div className="muted">Clique em uma linha para visualizar o resumo.</div>
            </div>
          </div>
          <LogGrid rows={rows} />
        </section>
      </section>
    </main>
  );
}

async function getAllPipelineRuns() {
  const rows: PipelineRun[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data } = await supabaseAdmin()
      .from("pipeline_runs")
      .select("id,status,stage,metrics,error_message,started_at,finished_at,created_at")
      .in("stage", ["product_load", "drive_collect"])
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1)
      .throwOnError();
    const page = (data || []) as PipelineRun[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function getAllPipelineLogs() {
  const rows: PipelineLog[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data } = await supabaseAdmin()
      .from("pipeline_logs")
      .select("id,message,payload,created_at")
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1)
      .throwOnError();
    const page = (data || []) as PipelineLog[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function runToGridRow(run: PipelineRun): LogGridRow & { sortDate: string } {
  const date = run.finished_at || run.started_at || run.created_at;
  return {
    id: `run-${run.id}`,
    date: formatDate(date),
    sortDate: date,
    process: run.stage === "product_load" ? "Carregamento de Produtos" : "Google Drive",
    status: statusLabel(run.status),
    summary: summaryForRun(run)
  };
}

function syncLogToGridRow(log: PipelineLog): LogGridRow & { sortDate: string } {
  return {
    id: `sync-${log.id}`,
    date: formatDate(log.created_at),
    sortDate: log.created_at,
    process: String(log.payload?.process || log.message || "Sincronismo"),
    status: statusLabel(String(log.payload?.status || "")),
    summary: String(log.payload?.summary || "Sem resumo.")
  };
}

function summaryForRun(run: PipelineRun) {
  if (run.stage === "product_load") {
    const products = run.metrics && typeof run.metrics === "object" && "products" in run.metrics
      ? (run.metrics as { products?: Record<string, unknown> }).products
      : undefined;
    const createdProducts = arrayOfRecords(products?.createdProducts);
    const duplicateProducts = arrayOfStrings(products?.duplicateProducts);
    const discardedItems = arrayOfRecords(products?.discardedItems);
    const errorItems = arrayOfRecords(products?.errorItems);
    return [
      `Produtos avaliados: ${Number(products?.totalGroups || 0)}.`,
      countWithItems(
        "Produtos incluídos",
        Number(products?.created || 0),
        createdProducts.map((item) => labeledSku(item.sku, item.sourceKey))
      ),
      Number(products?.duplicates || 0) > 0
        ? countWithItems("Produtos duplicados", Number(products?.duplicates || 0), duplicateProducts.map((sku) => `SKU ${sku}`))
        : "",
      Number(products?.discarded || 0) > 0
        ? countWithItems(
            "Itens descartados",
            Number(products?.discarded || 0),
            discardedItems.map((item) => `${stringValue(item.name) || "Item não identificado"} - ${stringValue(item.reason) || "Motivo não informado"}`)
          )
        : "",
      run.error_message ? `Erro: ${run.error_message}` : "",
      ...errorItems.map((item) => {
        const identifier = labeledSku(item.sku, item.sourceKey).replace(/^SKU /, "Produto ");
        return `${identifier} - Falha por ${stringValue(item.message) || "motivo não informado"}.`;
      })
    ].filter(Boolean).join("\n");
  }

  const drive = run.metrics && typeof run.metrics === "object" && "drive" in run.metrics
    ? (run.metrics as { drive?: Record<string, unknown> }).drive
    : undefined;
  const invocation = run.metrics && typeof run.metrics === "object" && "invocation" in run.metrics
    ? (run.metrics as { invocation?: Record<string, unknown> }).invocation
    : undefined;
  return [
    String(drive?.message || run.error_message || "Sem resumo."),
    invocation ? "Origem da solicitação:" : "",
    invocation ? `Recebida em: ${formatDate(stringValue(invocation.receivedAt))}` : "",
    invocation ? `Autenticação: ${stringValue(invocation.authenticationType) || "-"}` : "",
    invocation ? `Método e rota: ${stringValue(invocation.method) || "-"} ${stringValue(invocation.path) || "-"}${stringValue(invocation.query) || ""}` : "",
    invocation ? `Host: ${stringValue(invocation.host) || "-"}` : "",
    invocation ? `Origem HTTP: ${stringValue(invocation.origin) || "-"}` : "",
    invocation ? `Página de referência: ${stringValue(invocation.referer) || "-"}` : "",
    invocation ? `Cliente/User-Agent: ${stringValue(invocation.userAgent) || "-"}` : "",
    invocation ? `IP identificado: ${stringValue(invocation.ip) || "-"}` : "",
    invocation ? `Cadeia de IPs encaminhados: ${stringValue(invocation.forwardedFor) || "-"}` : "",
    invocation ? `Protocolo/host encaminhado: ${stringValue(invocation.forwardedProto) || "-"} / ${stringValue(invocation.forwardedHost) || "-"}` : "",
    invocation ? `Localização informada: ${[invocation.vercelCity, invocation.vercelRegionCode, invocation.vercelCountry].map(stringValue).filter(Boolean).join(" / ") || "-"}` : "",
    invocation ? `Fuso informado: ${stringValue(invocation.vercelTimezone) || "-"}` : "",
    invocation ? `Região de execução Vercel: ${stringValue(invocation.vercelRegion) || "-"}` : "",
    invocation ? `ID da requisição Vercel: ${stringValue(invocation.vercelRequestId) || "-"}` : "",
    invocation ? `Rastreamento: ${stringValue(invocation.traceParent) || "-"}` : "",
    invocation ? `Execução forçada: ${invocation.forced === true ? "Sim" : "Não"}` : ""
  ].filter(Boolean).join("\n");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : [];
}

function labeledSku(sku: unknown, fallback: unknown) {
  return `SKU ${stringValue(sku) || stringValue(fallback) || "não identificado"}`;
}

function countWithItems(label: string, count: number, items: string[]) {
  const details = items.filter(Boolean);
  return `${label}: ${count}.${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function statusLabel(status: string) {
  if (status === "done") return "Executado";
  if (status === "running" || status === "queued") return "Executando";
  return "Erro";
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "medium"
  });
}
