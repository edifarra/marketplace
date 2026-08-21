import { PipelineProgressButton } from "./components/pipeline-progress-button";
import { ProductLoadButton } from "./components/product-load-button";
import { Sidebar } from "./components/sidebar";
import { hasGoogleDriveConfig } from "@/lib/google-drive";
import { getGoogleDriveSettings } from "@/lib/google-drive-config";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getCurrentUser } from "@/lib/auth";
import { deferredShipping, overduePrintedLabel, salePostedAt, saleShippingAction } from "@/lib/sales-fulfillment";
import { AWAITING_SEND_PRODUCT_STATUSES } from "@/lib/product-sender";

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
  const driveNeedsReconnect = isGoogleDriveTokenExpiredOrRevoked(driveRunStatus.errorMessage);

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
          <Metric label="Aguardando envio" value={String(dashboardCounts.waiting)} helper="Inclui pendências de avaliação ou definição manual de preço." />
          <Metric label="Erros para revisar" value={String(dashboardCounts.errors)} helper="Produtos ou anúncios com status ou mensagem de erro." />
        </section>

        <section className="grid metrics sales-metrics" aria-label="Resumo de vendas">
          <Metric label="ENVIOS EM ATRASO" value={String(salesMetrics.overdueShipments)} alert={salesMetrics.overdueShipments > 0} />
          <Metric label="Vendas para enviar hoje" value={String(salesMetrics.toShipToday)} />
          <Metric label="Vendas desta semana" value={String(salesMetrics.currentWeek)} />
          <MetricWithTrend label="Vendas do mês" value={String(salesMetrics.currentMonthCount)} trend={salesMetrics.monthCountTrend} previousMonthTotal={String(salesMetrics.previousFullMonthCount)} />
          <Metric label="Valor total líquido do dia" value={formatCurrency(salesMetrics.currentDayNetValue)} helper={[
            `Valor total das taxas: ${formatCurrency(salesMetrics.currentDayFees)}`,
            `Valor total do frete: ${formatCurrency(salesMetrics.currentDayFreight)}`,
            `Valor bruto das vendas do dia: ${formatCurrency(salesMetrics.currentDayGrossValue)}`
          ]} />
          <MetricWithTrend label="Valor total das vendas do mês" value={formatCurrency(salesMetrics.currentMonthValue)} trend={salesMetrics.monthValueTrend} previousMonthTotal={formatCurrency(salesMetrics.previousFullMonthValue)} />
          <MetricWithTrend label="Valor líquido a receber" value={formatCurrency(salesMetrics.currentMonthNetValue)} trend={salesMetrics.monthNetTrend} previousMonthTotal={formatCurrency(salesMetrics.previousFullMonthNetValue)} />
          <MetricWithTrend label="Valor a pagar de frete do mês" value={formatCurrency(salesMetrics.currentMonthFreight)} trend={salesMetrics.monthFreightTrend} previousMonthTotal={formatCurrency(salesMetrics.previousFullMonthFreight)} />
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
                    {driveNeedsAttention && !driveNeedsReconnect && (
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
                  {driveNeedsReconnect ? (
                    <a className="secondary link-button pipeline-review-drive" href="/configuracoes/google-drive">
                      Revisar GoogleDrive
                    </a>
                  ) : (
                    <PipelineProgressButton
                      endpoint="/api/pipeline/run?force=1"
                      progressEndpoint="/api/pipeline/drive/progress"
                      idleLabel="Executar Agora"
                      runningLabel="Processando..."
                      disabled={!driveConfigured}
                      hideSuccessMessage
                    />
                  )}
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

      </section>
    </main>
  );
}

async function getDashboardProductCounts(supabase: ReturnType<typeof supabaseAdmin>) {
  const [
    activeResult,
    zeroStockResult,
    waitingResult,
    productErrorsResult,
    listingErrorsResult
  ] = await Promise.all([
    supabase.from("products").select("*", { count: "exact", head: true }).gt("stock", 0),
    supabase.from("products").select("*", { count: "exact", head: true }).eq("stock", 0),
    supabase.from("products").select("*", { count: "exact", head: true }).in("status", AWAITING_SEND_PRODUCT_STATUSES),
    supabase.from("products").select("id").eq("status", "error"),
    supabase.from("listings").select("product_id").or("status.eq.error,error_message.not.is.null")
  ]);

  const errorProductIds = new Set<string>([
    ...(productErrorsResult.data || []).map((row) => String(row.id)),
    ...(listingErrorsResult.data || []).filter((row) => row.product_id).map((row) => String(row.product_id))
  ]);

  return {
    active: activeResult.count ?? 0,
    zeroStock: zeroStockResult.count ?? 0,
    waiting: waitingResult.count ?? 0,
    errors: errorProductIds.size
  };
}

type DashboardSale = {
  marketplace: string;
  status_original: string | null;
  valor_produtos: number | string | null;
  valor_frete: number | string | null;
  valor_taxas: number | string | null;
  valor_descontos: number | string | null;
  valor_liquido: number | string | null;
  data_venda: string | null;
  created_at: string;
  updated_at: string;
  raw_data: Record<string, unknown> | null;
};

async function getDashboardSalesMetrics(supabase: ReturnType<typeof supabaseAdmin>) {
  const { data } = await supabase
    .from("venda")
    .select("marketplace,status_original,valor_produtos,valor_frete,valor_taxas,valor_descontos,valor_liquido,data_venda,created_at,updated_at,raw_data")
    .throwOnError();
  const sales = ((data || []) as DashboardSale[]).filter(isEffectiveSale);
  const now = new Date();
  const currentWeek = localWeekRange(now);
  const currentMonth = localMonthRange(now, 0);
  const previousMonth = localMonthRange(now, -1);
  const previousComparableMonth = previousMonthComparableRange(now);

  const salesToShipToday = sales.filter((sale) =>
    !deferredShipping(sale) && !overduePrintedLabel(sale) && Boolean(saleShippingAction(sale))
  );
  const toShipToday = salesToShipToday.length;
  const overdueShipments = sales.filter((sale) => overduePrintedLabel(sale)).length;

  const currentWeekCount = sales.filter((sale) => {
    const postedAt = salePostedAt(sale);
    return postedAt ? isWithin(postedAt, currentWeek.start, currentWeek.end) : false;
  }).length;

  const monthSales = sales.filter((sale) => isWithin(saleDate(sale), currentMonth.start, currentMonth.end));
  const previousMonthSales = sales.filter((sale) => isWithin(saleDate(sale), previousMonth.start, previousMonth.end));
  const previousComparableSales = sales.filter((sale) => isWithin(saleDate(sale), previousComparableMonth.start, previousComparableMonth.end));
  const currentMonthValue = sumSales(monthSales);
  const currentDayNetValue = sumNetSales(salesToShipToday);
  const currentDayGrossValue = sumSales(salesToShipToday);
  const currentDayFees = sumSaleField(salesToShipToday, "valor_taxas");
  const currentDayFreight = sumSaleField(salesToShipToday, "valor_frete");
  const previousMonthValue = sumSales(previousMonthSales);
  const currentMonthNetValue = sumNetSales(monthSales);
  const previousMonthNetValue = sumNetSales(previousMonthSales);
  const currentMonthFreight = sumSaleField(monthSales, "valor_frete");
  const previousMonthFreight = sumSaleField(previousMonthSales, "valor_frete");
  const previousComparableValue = sumSales(previousComparableSales);
  const previousComparableNetValue = sumNetSales(previousComparableSales);
  const previousComparableFreight = sumSaleField(previousComparableSales, "valor_frete");

  return {
    toShipToday,
    overdueShipments,
    currentWeek: currentWeekCount,
    currentMonthCount: monthSales.length,
    currentDayNetValue,
    currentDayGrossValue,
    currentDayFees,
    currentDayFreight,
    currentMonthValue,
    currentMonthNetValue,
    currentMonthFreight,
    previousFullMonthCount: previousMonthSales.length,
    previousFullMonthValue: previousMonthValue,
    previousFullMonthNetValue: previousMonthNetValue,
    previousFullMonthFreight: previousMonthFreight,
    monthCountTrend: percentageChange(monthSales.length, previousComparableSales.length),
    monthValueTrend: percentageChange(currentMonthValue, previousComparableValue),
    monthNetTrend: percentageChange(currentMonthNetValue, previousComparableNetValue),
    monthFreightTrend: percentageChange(currentMonthFreight, previousComparableFreight)
  };
}

function Metric({ label, value, helper, alert = false }: { label: string; value: string; helper?: string | string[]; alert?: boolean }) {
  return (
    <div className={`card${alert ? " metric-alert" : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {helper && (Array.isArray(helper)
        ? helper.map((line) => <div className="metric-comparison" key={line}>{line}</div>)
        : <div className="metric-comparison">{helper}</div>)}
    </div>
  );
}

function MetricWithTrend({ label, value, trend, previousMonthTotal }: { label: string; value: string; trend: number; previousMonthTotal: string }) {
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
      <div className="metric-comparison">comparado ao mesmo período do mês anterior</div>
      <div className="metric-comparison">Total do mês anterior: {previousMonthTotal}</div>
    </div>
  );
}

function isEffectiveSale(sale: DashboardSale) {
  return !/(^pending$|payment_required|payment_in_process|unpaid|nao_paga|aguardando.*pagamento|cancel|refund|reembols|not_delivered)/i
    .test(String(sale.status_original || ""));
}

function saleDate(sale: DashboardSale) {
  return new Date(sale.data_venda || sale.created_at);
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

function previousMonthComparableRange(date: Date) {
  const parts = saoPauloParts(date);
  const start = saoPauloDate(parts.year, parts.month - 2, 1);
  const previousMonthEnd = saoPauloDate(parts.year, parts.month - 1, 1);
  const samePeriodEnd = saoPauloDate(parts.year, parts.month - 2, parts.day + 1);
  return { start, end: samePeriodEnd < previousMonthEnd ? samePeriodEnd : previousMonthEnd };
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

function sumSaleField(sales: DashboardSale[], field: "valor_frete" | "valor_taxas" | "valor_liquido") {
  return sales.reduce((total, sale) => total + Number(sale[field] || 0), 0);
}

function sumNetSales(sales: DashboardSale[]) {
  return sales.reduce((total, sale) =>
    total
    + Number(sale.valor_produtos || 0)
    - Number(sale.valor_taxas || 0)
    - Number(sale.valor_descontos || 0)
    - Number(sale.valor_frete || 0), 0);
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

  if (isGoogleDriveTokenExpiredOrRevoked(errorMessage)) {
    return "Reconectar Google Drive";
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

function isGoogleDriveTokenExpiredOrRevoked(value: string | null | undefined) {
  const message = String(value || "").toLowerCase();
  return message.includes("token has been expired or revoked")
    || message.includes("token has been revoked")
    || (message.includes("invalid_grant") && (message.includes("expired") || message.includes("revoked")));
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
