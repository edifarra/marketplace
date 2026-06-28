import { NextRequest, NextResponse } from "next/server";
import { loadProductsFromDriveImages } from "@/lib/product-loader";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return executeProductLoad(request);
}

export async function GET(request: NextRequest) {
  return executeProductLoad(request);
}

async function executeProductLoad(request: NextRequest) {
  const secret = request.headers.get("x-cron-secret");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }

  const supabase = supabaseAdmin();
  const run = await supabase
    .from("pipeline_runs")
    .insert({ status: "running", stage: "product_load", started_at: new Date().toISOString() })
    .select()
    .single()
    .throwOnError();

  try {
    await saveProgress({
      status: "running",
      runId: run.data.id,
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      currentFile: "",
      message: "Iniciando carregamento de produtos."
    });
    const result = await loadProductsFromDriveImages(async (progress) => {
      await saveProgress({
        status: "running",
        runId: run.data.id,
        ...progress,
        message: progress.totalFiles > 0
          ? `Processando ${progress.processedFiles} de ${progress.totalFiles} foto(s).`
          : "Nenhuma foto valida localizada."
      });
    });
    const finishedAt = new Date().toISOString();
    await saveProgress({
      status: result.failed > 0 ? "failed" : "done",
      runId: run.data.id,
      totalFiles: result.totalFiles,
      processedFiles: result.totalFiles,
      percent: 100,
      currentFile: "",
      message: `Concluido. Criados: ${result.created}; duplicados: ${result.duplicates}; descartados: ${result.discarded}; falhas: ${result.failed}.`
    });
    await supabase
      .from("pipeline_runs")
      .update({
        status: result.failed > 0 ? "failed" : "done",
        stage: "product_load",
        metrics: { products: result },
        error_message: result.failed > 0 ? "Alguns produtos falharam no carregamento." : null,
        finished_at: finishedAt
      })
      .eq("id", run.data.id)
      .throwOnError();

    return NextResponse.json({ ok: result.failed === 0, runId: run.data.id, products: result });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Erro desconhecido no carregamento de produtos.";
    await saveProgress({
      status: "failed",
      runId: run.data.id,
      totalFiles: 0,
      processedFiles: 0,
      percent: 0,
      currentFile: "",
      message
    });
    await supabase
      .from("pipeline_runs")
      .update({
        status: "failed",
        stage: "product_load",
        error_message: message,
        finished_at: finishedAt
      })
      .eq("id", run.data.id)
      .throwOnError();

    return NextResponse.json({ ok: false, runId: run.data.id, error: message }, { status: 500 });
  }
}

async function saveProgress(progress: Record<string, unknown>) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert({
    key: "PRODUCT_LOAD_PROGRESS",
    value: {
      ...progress,
      updatedAt: new Date().toISOString()
    },
    description: "[CONFIG_GERAL] Progresso do carregamento de produtos"
  });
}
