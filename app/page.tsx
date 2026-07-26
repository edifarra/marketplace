import { PipelineProgressButton } from "./components/pipeline-progress-button";
import { ProductLoadButton } from "./components/product-load-button";
import { Sidebar } from "./components/sidebar";
import { hasGoogleDriveConfig } from "@/lib/google-drive";
import { getGoogleDriveSettings } from "@/lib/google-drive-config";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function HomePage() {
  const currentUser = await getCurrentUser();
  const supabase = supabaseAdmin();
  const dashboardCounts = await getDashboardProductCounts(supabase);
  const salesMetrics = await getDashboardSalesMetrics(supabase);

  const { data: lastDriveRun } = await supabase
    .from("pipeline_runs")
    .select("status, metrics, error_message, finished_at")
    .eq("stage", "drive_collect")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const { data: driveLastRunSettings } = await supabase
    .from("settings")
    .select("key,value")
    .in("key", ["DRIVE_LAST_RUN_AT", "DRIVE_LAST_RUN_STATUS", "DRIVE_LAST_RUN_RESULT"]);

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
  const driveRunStatus = buildDriveRunStatus(lastDriveRun, driveLastRunSettings ?? []);
  const driveNeedsAttention = !driveConfigured || driveRunStatus.status !== "done";

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
          {currentUser && <div className="current-user">Usuario: <strong>{currentUser.name}</strong></div>}
        </div>

        <section className="grid metrics">
          <Metric label="Produtos ativos" value={String(dashboardCounts.active)} />
          <Metric label="Estoque zerado" value={String(dashboardCounts.zeroStock)} />
          <Metric label="Aguardando envio" value={String(dashboardCounts.waiting)} />
          <Metric label="Erros para revisar" value={String(dashboardCounts.errors)} />
        </section>

        <section className="grid metrics sales-metrics" aria-label="Resumo de vendas">
          <Metric label="Vendas para enviar hoje" value={String(salesMetrics.toShipToday)} />
          <Metric label="Vendas desta semana" value={String(salesMetrics.currentWeek)} />
          <MetricWithTrend label="Vendas do mês" value={String(salesMetrics.currentMonthCount)} trend={salesMetrics.monthCountTrend} />
          <MetricWithTrend label="Valor total das vendas do mês" value={formatCurrency(salesMetrics.currentMonthValue)} trend={salesMetrics.monthValueTrend} />
          <MetricWithTrend label="Valor líquido a receber" value={formatCurrency(salesMetrics.currentMonthNetValue)} trend={salesMetrics.monthNetTrend} />
          <MetricWithTrend label="Valor a pagar de frete do mês" value={formatCurrency(salesMetrics.currentMonthFreight)} trend={salesMetrics.monthFreightTrend} />
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
                <td>
                  <div className="pipeline-step-name">
                    {driveNeedsAttention && (
                      <span className="pipeline-attention" role="img" aria-label="Atenção" title="A conexão ou a última execução do Google Drive precisa ser verificada">
                        !
                      </span>
                    )}
                    <span>Google Drive</span>
                    {driveNeedsAttention && (
                      <a className="secondary compact link-button pipeline-verify" href="/configuracoes/google-drive">
                        Verificar
                      </a>
                    )}
                  </div>
                </td>
                <td>Busca imagens validas e ignora duplicadas</td>
                <td>
                  <span className="status">{driveStatusLabel(driveRunStatus.status, driveRunStatus.errorMessage, driveConfigured)}</span>
                  <div className="muted pipeline-result">
                    {formatDriveResult(driveRunStatus, driveSettings.intervalMinutes)}
                  </div>
                </td>
                <td>
                  <PipelineProgressButton
                    endpoint="/api/pipeline/run?force=1"
                    progressEndpoint="/api/pipeline/drive/progress"
                    idleLabel="Executar Agora"
                    runningLabel="Processando..."
                    disabled={!driveConfigured}
                    hideSuccessMessage
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

async function getDashboardProductCounts(supabase: ReturnType<typeof supabaseAdmin>) {
  const [
    activeResult,
    zeroStockResult,
    productsResult,
    listingLinksResult,
    marketplaceLinksResult,
    productErrorsResult,
    listingErrorsResult
  ] = await Promise.all([
    supabase.from("products").select("*", { count: "exact", head: true }).gt("stock", 0),
    supabase.from("products").select("*", { count: "exact", head: true }).eq("stock", 0),
    supabase.from("products").select("id,tiny_product_id,sent_target"),
    supabase.from("listings").select("product_id").not("external_listing_id", "is", null),
    supabase.from("product_marketplaces").select("product_id").eq("existe_no_marketplace", true).not("product_id", "is", null),
    supabase.from("products").select("id").eq("status", "error"),
    supabase.from("listings").select("product_id").or("status.eq.error,error_message.not.is.null")
  ]);

  const linkedProductIds = new Set<string>([
    ...(listingLinksResult.data || []).map((row) => String(row.product_id)),
    ...(marketplaceLinksResult.data || []).map((row) => String(row.product_id))
  ]);
  const waiting = (productsResult.data || []).filter((product) => {
    const linkedToTiny = Boolean(product.tiny_product_id || product.sent_target === "TINY");
    return !linkedToTiny && !linkedProductIds.has(String(product.id));
  }).length;

  const errorProductIds = new Set<string>([
    ...(productErrorsResult.data || []).map((row) => String(row.id)),
    ...(listingErrorsResult.data || []).map((row) => String(row.product_id))
  ]);

  return {
    active: activeResult.count ?? 0,
    zeroStock: zeroStockResult.count ?? 0,
    waiting,
    errors: errorProductIds.size
  };
}

type DashboardSale = {
  status_original: string | null;
  valor_produtos: number | string | null;
  valor_frete: number | string | null;
  valor_liquido: number | string | null;
  data_venda: string | null;
  created_at: string;
  updated_at: string;
  raw_data: Record<string, unknown> | null;
};

async function getDashboardSalesMetrics(supabase: ReturnType<typeof supabaseAdmin>) {
  const { data } = await supabase
    .from("venda")
    .select("status_original,valor_produtos,valor_frete,valor_liquido,data_venda,created_at,updated_at,raw_data")
    .throwOnError();
  const sales = ((data || []) as DashboardSale[]).filter(isEffectiveSale);
  const now = new Date();
  const today = localDayRange(now);
  const currentWeek = localWeekRange(now);
  const currentMonth = localMonthRange(now, 0);
  const previousMonth = localMonthRange(now, -1);

  const toShipToday = sales.filter((sale) => {
    if (isPostedSale(sale.status_original)) return false;
    const comparisonDate = extractShippingDeadline(sale.raw_data) || saleDate(sale);
    return isWithin(comparisonDate, today.start, today.end);
  }).length;

  const currentWeekCount = sales.filter((sale) => {
    const comparisonDate = isPostedSale(sale.status_original)
      ? extractPostedAt(sale.raw_data) || new Date(sale.updated_at)
      : saleDate(sale);
    return isWithin(comparisonDate, currentWeek.start, currentWeek.end);
  }).length;

  const monthSales = sales.filter((sale) => isWithin(saleDate(sale), currentMonth.start, currentMonth.end));
  const previousMonthSales = sales.filter((sale) => isWithin(saleDate(sale), previousMonth.start, previousMonth.end));
  const currentMonthValue = sumSales(monthSales);
  const previousMonthValue = sumSales(previousMonthSales);
  const currentMonthNetValue = sumSaleField(monthSales, "valor_liquido");
  const previousMonthNetValue = sumSaleField(previousMonthSales, "valor_liquido");
  const currentMonthFreight = sumSaleField(monthSales, "valor_frete");
  const previousMonthFreight = sumSaleField(previousMonthSales, "valor_frete");

  return {
    toShipToday,
    currentWeek: currentWeekCount,
    currentMonthCount: monthSales.length,
    currentMonthValue,
    currentMonthNetValue,
    currentMonthFreight,
    monthCountTrend: percentageChange(monthSales.length, previousMonthSales.length),
    monthValueTrend: percentageChange(currentMonthValue, previousMonthValue),
    monthNetTrend: percentageChange(currentMonthNetValue, previousMonthNetValue),
    monthFreightTrend: percentageChange(currentMonthFreight, previousMonthFreight)
  };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function MetricWithTrend({ label, value, trend }: { label: string; value: string; trend: number }) {
  const direction = trend > 0 ? "up" : trend < 0 ? "down" : "neutral";
  return (
    <div className="card">
      <div className="metric-label">{label}</div>
      <div className="metric-value metric-value-with-trend">
        <span>{value}</span>
        <span className={`metric-trend ${direction}`} title="Comparação com o mês anterior">
          <span aria-hidden="true">{trend > 0 ? "↑" : trend < 0 ? "↓" : "→"}</span>
          {Math.abs(trend)}%
        </span>
      </div>
      <div className="metric-comparison">comparado ao mês anterior</div>
    </div>
  );
}

function isEffectiveSale(sale: DashboardSale) {
  return !/(cancel|refund|reembols|not_delivered)/i.test(String(sale.status_original || ""));
}

function isPostedSale(status: string | null) {
  return /^(shipped|in_transit|out_for_delivery|delivered|completed|sent|enviado|enviada|a_caminho)$/i.test(String(status || ""));
}

function saleDate(sale: DashboardSale) {
  return new Date(sale.data_venda || sale.created_at);
}

function extractPostedAt(raw: Record<string, unknown> | null) {
  const payload = unwrapSalePayload(raw);
  const shipment = payload?.shipment || payload?.order?.shipping || payload?.data?.shipment || {};
  return firstValidDate([
    shipment?.status_history?.date_shipped,
    shipment?.date_shipped,
    shipment?.shipped_at,
    shipment?.update_time
  ]);
}

function extractShippingDeadline(raw: Record<string, unknown> | null) {
  const payload = unwrapSalePayload(raw);
  const order = payload?.order || payload?.data || payload || {};
  return firstValidDate([
    order?.ship_by_date,
    order?.shipping_deadline,
    order?.shipping?.shipping_option?.estimated_delivery_time?.shipping?.limit?.date,
    order?.shipping?.estimated_handling_limit
  ]);
}

function unwrapSalePayload(raw: Record<string, unknown> | null): any {
  if (!raw) return {};
  return (raw.payload || raw) as Record<string, unknown>;
}

function firstValidDate(values: unknown[]) {
  for (const value of values) {
    if (!value) continue;
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(String(value));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function localDayRange(date: Date) {
  const parts = saoPauloParts(date);
  return rangeFromParts(parts.year, parts.month, parts.day, 1);
}

function localWeekRange(date: Date) {
  const parts = saoPauloParts(date);
  const local = saoPauloDate(parts.year, parts.month - 1, parts.day);
  const dayOfWeek = local.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const start = new Date(local.getTime() + mondayOffset * 86_400_000);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

function localMonthRange(date: Date, monthOffset: number) {
  const parts = saoPauloParts(date);
  const start = saoPauloDate(parts.year, parts.month - 1 + monthOffset, 1);
  const end = saoPauloDate(parts.year, parts.month + monthOffset, 1);
  return { start, end };
}

function rangeFromParts(year: number, month: number, day: number, days: number) {
  const start = saoPauloDate(year, month - 1, day);
  return { start, end: new Date(start.getTime() + days * 86_400_000) };
}

function saoPauloDate(year: number, zeroBasedMonth: number, day: number) {
  return new Date(Date.UTC(year, zeroBasedMonth, day, 3));
}

function saoPauloParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "numeric", day: "numeric"
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function isWithin(value: Date, start: Date, end: Date) {
  const time = value.getTime();
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

function sumSales(sales: DashboardSale[]) {
  return sales.reduce((total, sale) => total + Number(sale.valor_produtos || 0), 0);
}

function sumSaleField(sales: DashboardSale[], field: "valor_frete" | "valor_liquido") {
  return sales.reduce((total, sale) => total + Number(sale[field] || 0), 0);
}

function percentageChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 100);
}

function formatCurrency(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

type DriveRunView = {
  status: string | null;
  metrics: unknown;
  errorMessage: string | null;
  finishedAt: string | null;
};

function buildDriveRunStatus(
  run: { status: string; metrics: unknown; error_message: string | null; finished_at: string | null } | null,
  settingsRows: Array<{ key: string; value: unknown }>
): DriveRunView {
  const settings = new Map(settingsRows.map((row) => [row.key, row.value]));
  const settingsFinishedAt = settingToString(settings.get("DRIVE_LAST_RUN_AT"));
  const settingsStatus = settingToString(settings.get("DRIVE_LAST_RUN_STATUS"));
  const settingsResult = settings.get("DRIVE_LAST_RUN_RESULT");

  if (settingsFinishedAt && isSameOrAfter(settingsFinishedAt, run?.finished_at)) {
    return {
      status: settingsStatus === "OK" ? "done" : settingsStatus === "EM_EXECUCAO" ? "running" : "failed",
      metrics: settingsStatus === "OK" ? { drive: settingsResult } : null,
      errorMessage: settingsStatus === "ERRO" ? extractSettingsMessage(settingsResult) : null,
      finishedAt: settingsFinishedAt
    };
  }

  return {
    status: run?.status ?? null,
    metrics: run?.metrics ?? null,
    errorMessage: run?.error_message ?? null,
    finishedAt: run?.finished_at ?? null
  };
}

function driveStatusLabel(status: string | null | undefined, errorMessage: string | null | undefined, configured: boolean) {
  if (!configured) {
    return "Configurar credenciais";
  }

  if (isLegacyGoogleOAuthError(errorMessage)) {
    return "Conta conectada";
  }

  if (!status) {
    return "Aguardando primeira execucao";
  }

  if (status === "running") {
    return "Executando";
  }

  return status === "done" ? "Executado" : "Erro na ultima execucao";
}

function pipelineStatusLabel(status: string | null | undefined) {
  if (!status) {
    return "Aguardando primeira execucao";
  }

  return status === "done" ? "Executado" : "Erro na ultima execucao";
}

function formatDriveResult(run: DriveRunView, intervalMinutes: number) {
  if (!run.finishedAt) {
    return `Ultima execucao: ainda nao executado. Intervalo configurado: ${intervalMinutes} minuto(s).`;
  }

  const date = new Date(run.finishedAt).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short"
  });

  if (run.status === "running") {
    return `Ultima execucao: ${date}. Execucao em andamento. Buscando imagens no Google Drive.`;
  }

  if (isLegacyGoogleOAuthError(run.errorMessage)) {
    return `Conta Google Drive conectada. Clique em Executar Agora para iniciar uma nova busca. Intervalo configurado: ${intervalMinutes} minuto(s).`;
  }

  if (run.status !== "done") {
    return `Ultima execucao: ${date}. Erro: ${run.errorMessage || "nao informado"}. Proxima tentativa em ${intervalMinutes} minuto(s).`;
  }

  const drive = extractDriveMetrics(run.metrics);
  if (!drive) {
    return `Ultima execucao: ${date}.`;
  }

  if (drive.totalTransferable === 0 || drive.message) {
    return `Ultima execucao: ${date}.`;
  }

  return `Ultima execucao: ${date}. Movidas: ${drive.totalMoved}; copiadas: ${drive.totalCopied}; falhas: ${drive.totalFailed}.`;
}

function isSameOrAfter(value: string, comparison: string | null | undefined) {
  if (!comparison) {
    return true;
  }

  return new Date(value).getTime() >= new Date(comparison).getTime();
}

function extractSettingsMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("message" in value)) {
    return "";
  }

  return String((value as { message?: unknown }).message || "");
}

function settingToString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

function isLegacyGoogleOAuthError(value: string | null | undefined) {
  return Boolean(value?.includes("GOOGLE_OAUTH_CLIENT_ID"));
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
    totalTransferable: Number(drive.totalTransferable || 0),
    totalMoved: Number(drive.totalMoved || 0),
    totalCopied: Number(drive.totalCopied || 0),
    totalFailed: Number(drive.totalFailed || 0),
    message: typeof drive.message === "string" ? drive.message : ""
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
