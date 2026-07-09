import { NextRequest, NextResponse } from "next/server";
import { buildDriveCompletionMessage, collectDriveImages, hasGoogleDriveConfig } from "@/lib/google-drive";
import { getGoogleDriveSettings } from "@/lib/google-drive-config";
import { supabaseAdmin } from "@/lib/supabase-admin";

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

  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }

  const supabase = supabaseAdmin();
  const forced = request.nextUrl.searchParams.get("force") === "1";
  const settings = await getGoogleDriveSettings();

  if (!forced) {
    const wait = await shouldWaitForNextRun(settings.intervalMinutes);
    if (wait.wait) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `Aguardando intervalo de ${settings.intervalMinutes} minuto(s).`,
        nextRunAt: wait.nextRunAt
      });
    }
  }

  const run = await supabase
    .from("pipeline_runs")
    .insert({ status: "running", stage: "drive_collect", started_at: new Date().toISOString() })
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

    const driveResult = await collectDriveImages(saveDriveProgress);
    const finishedAt = new Date().toISOString();
    const completionMessage = buildDriveCompletionMessage(driveResult);

    await supabase
      .from("pipeline_runs")
      .update({
        status: "done",
        stage: "drive_collect",
        metrics: {
          drive: {
            ...driveResult,
            message: completionMessage
          }
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
    return NextResponse.json({ ok: true, runId: run.data.id, drive: driveResult });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Erro desconhecido na coleta do Google Drive.";

    await supabase
      .from("pipeline_runs")
      .update({
        status: "failed",
        stage: "drive_collect",
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
    return NextResponse.json({ ok: false, runId: run.data.id, error: message }, { status: 500 });
  }
}

async function shouldWaitForNextRun(intervalMinutes: number) {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("pipeline_runs")
    .select("finished_at,status")
    .eq("stage", "drive_collect")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!data?.finished_at) {
    return { wait: false, nextRunAt: "" };
  }

  const nextRunAtDate = new Date(new Date(data.finished_at).getTime() + intervalMinutes * 60_000);
  return {
    wait: Date.now() < nextRunAtDate.getTime(),
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
  ]);
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
