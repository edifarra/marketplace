import { NextRequest, NextResponse } from "next/server";
import { buildDriveCompletionMessage, collectDriveImages, hasGoogleDriveConfig } from "@/lib/google-drive";
import { getGoogleDriveSettings } from "@/lib/google-drive-config";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadProductsFromDriveImages } from "@/lib/product-loader";
import { sendPendingProductsToConfiguredTarget } from "@/lib/product-sender";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  return executePipeline(request);
}

export async function GET(request: NextRequest) {
  return executePipeline(request);
}

async function executePipeline(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const forced = request.nextUrl.searchParams.get("force") === "1";
  const dashboardAuthenticated = request.headers.get("x-dashboard-authenticated") === "1";
  const invocation = buildInvocationDetails(request, {
    dashboardAuthenticated,
    cronSecretAuthenticated: Boolean(process.env.CRON_SECRET && secret === process.env.CRON_SECRET),
    bearerAuthenticated: Boolean(process.env.CRON_SECRET && bearer === process.env.CRON_SECRET),
    forced
  });

  if (!dashboardAuthenticated && (!process.env.CRON_SECRET || (secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET))) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }

  const supabase = supabaseAdmin();
  const settings = await getGoogleDriveSettings();
  const startedAt = new Date().toISOString();

  if (!forced) {
    const wait = shouldWaitForScheduledTime(settings.intervalMinutes);
    if (wait.wait) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `Fora do horario programado para a frequencia de ${settings.intervalMinutes / 60} hora(s).`,
        nextRunAt: wait.nextRunAt
      });
    }
  }

  const run = await supabase
    .from("pipeline_runs")
    .insert({ status: "running", stage: "drive_collect", started_at: startedAt, metrics: { invocation } })
    .select()
    .single()
    .throwOnError();

  try {
    if (!(await hasGoogleDriveConfig())) {
      throw new Error("Credenciais do Google Drive incompletas.");
    }

    await saveDriveProgress({
      status: "running",
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      message: "Iniciando busca no Google Drive."
    });
    await upsertPipelineSettings(startedAt, "EM_EXECUCAO", {
      message: "Execucao manual iniciada. Buscando imagens no Google Drive."
    });

    const driveResult = await collectDriveImages(saveDriveProgress);
    const automatic = await runAutomaticStages(driveResult);
    const finishedAt = new Date().toISOString();
    const completionMessage = buildDriveCompletionMessage(driveResult);

    await supabase
      .from("pipeline_runs")
      .update({
        status: "done",
        stage: "drive_collect",
        metrics: {
          invocation,
          drive: {
            ...driveResult,
            message: completionMessage
          }
          , automatic
        },
        finished_at: finishedAt
      })
      .eq("id", run.data.id)
      .throwOnError();

    await upsertPipelineSettings(finishedAt, "OK", {
      ...driveResult,
      message: completionMessage
    });
    await saveDriveProgress({
      status: "done",
      totalFiles: driveResult.totalTransferable,
      processedFiles: driveResult.totalMoved + driveResult.totalCopied + driveResult.totalFailed,
      percent: 100,
      message: completionMessage
    });
    return NextResponse.json({
      ok: true,
      runId: run.data.id,
      finishedAt,
      message: completionMessage,
      drive: driveResult
      , automatic
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Erro desconhecido na coleta do Google Drive.";

    await supabase
      .from("pipeline_runs")
      .update({
        status: "failed",
        stage: "drive_collect",
        metrics: { invocation },
        error_message: message,
        finished_at: finishedAt
      })
      .eq("id", run.data.id)
      .throwOnError();

    await upsertPipelineSettings(finishedAt, "ERRO", { message });
    await saveDriveProgress({
      status: "failed",
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      message
    });
    return NextResponse.json({ ok: false, runId: run.data.id, error: message, finishedAt }, { status: 500 });
  }
}

function buildInvocationDetails(
  request: NextRequest,
  authentication: {
    dashboardAuthenticated: boolean;
    cronSecretAuthenticated: boolean;
    bearerAuthenticated: boolean;
    forced: boolean;
  }
) {
  const headers = request.headers;
  const authenticationType = authentication.dashboardAuthenticated
    ? "dashboard"
    : authentication.cronSecretAuthenticated
      ? "x-cron-secret"
      : authentication.bearerAuthenticated
        ? "bearer"
        : "nao_identificada";

  return {
    receivedAt: new Date().toISOString(),
    method: request.method,
    path: request.nextUrl.pathname,
    query: request.nextUrl.search,
    host: headers.get("host"),
    origin: headers.get("origin"),
    referer: headers.get("referer"),
    userAgent: headers.get("user-agent"),
    ip: headers.get("x-real-ip") || firstForwardedValue(headers.get("x-forwarded-for")),
    forwardedFor: headers.get("x-forwarded-for"),
    forwardedHost: headers.get("x-forwarded-host"),
    forwardedProto: headers.get("x-forwarded-proto"),
    vercelRequestId: headers.get("x-vercel-id"),
    traceParent: headers.get("traceparent"),
    vercelRegion: process.env.VERCEL_REGION || null,
    vercelCountry: headers.get("x-vercel-ip-country"),
    vercelRegionCode: headers.get("x-vercel-ip-country-region"),
    vercelCity: decodeHeader(headers.get("x-vercel-ip-city")),
    vercelTimezone: headers.get("x-vercel-ip-timezone"),
    authenticationType,
    forced: authentication.forced
  };
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function decodeHeader(value: string | null) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function runAutomaticStages(driveResult: { totalMoved: number; totalCopied: number }) {
  const supabase = supabaseAdmin();
  const { data } = await supabase.from("settings").select("key,value").in("key", [
    "CARREGAMENTO_PRODUTOS_AUTOMATICO",
    "ENVIAR_PRODUTOS_AUTOMATICO"
  ]);
  const values = new Map((data || []).map((item) => [item.key, String(item.value || "").trim().toUpperCase()]));
  const hasNewPhotos = driveResult.totalMoved + driveResult.totalCopied > 0;
  const result: Record<string, unknown> = { triggered: true, hasNewPhotos };
  if (hasNewPhotos && values.get("CARREGAMENTO_PRODUTOS_AUTOMATICO") === "SIM") {
    result.productLoad = await loadProductsFromDriveImages();
  }
  if (values.get("ENVIAR_PRODUTOS_AUTOMATICO") === "SIM") {
    result.productSend = await sendPendingProductsToConfiguredTarget(5);
  }
  if (!hasNewPhotos) result.reason = "Nenhuma foto nova; pendencias de envio verificadas.";
  return result;
}

function shouldWaitForScheduledTime(intervalMinutes: number) {
  const intervalHours = intervalMinutes / 60;
  const now = new Date();
  const currentUtcHour = now.getUTCHours();
  const isScheduledHour = Number.isInteger(intervalHours) && currentUtcHour % intervalHours === 0;
  const nextRunAtDate = new Date(now);
  nextRunAtDate.setUTCMinutes(0, 0, 0);
  nextRunAtDate.setUTCHours(currentUtcHour + (isScheduledHour ? intervalHours : intervalHours - (currentUtcHour % intervalHours)));

  return {
    wait: !isScheduledHour,
    nextRunAt: nextRunAtDate.toISOString()
  };
}

async function upsertPipelineSettings(finishedAt: string, status: string, payload: unknown) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert([
    {
      key: "DRIVE_LAST_RUN_AT",
      value: finishedAt,
      description: "[CONFIG_GERAL] Ultima execucao da coleta do Google Drive"
    },
    {
      key: "DRIVE_LAST_RUN_STATUS",
      value: status,
      description: "[CONFIG_GERAL] Status da ultima coleta do Google Drive"
    },
    {
      key: "DRIVE_LAST_RUN_RESULT",
      value: payload,
      description: "[CONFIG_GERAL] Resultado da ultima coleta do Google Drive"
    }
  ]).throwOnError();
}

async function saveDriveProgress(progress: Record<string, unknown>) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert({
    key: "DRIVE_COLLECT_PROGRESS",
    value: {
      ...progress,
      updatedAt: new Date().toISOString()
    },
    description: "[CONFIG_GERAL] Progresso da coleta do Google Drive"
  });
}
