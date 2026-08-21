import { supabaseAdmin } from "./supabase-admin";

export type SynchronizationLogTotals = {
  evaluated: number;
  updated: number;
  removed: number;
  included: number;
};

export type SynchronizationLogFailure = {
  sku: string;
  reason: string;
};

export async function logSynchronizationResult(input: {
  process: string;
  status: "done" | "failed";
  totals: SynchronizationLogTotals;
  error?: string;
  failures?: SynchronizationLogFailure[];
}) {
  const summary = [
    `Produtos avaliados: ${input.totals.evaluated}.`,
    `Produtos atualizados: ${input.totals.updated}.`,
    `Produtos removidos: ${input.totals.removed}.`,
    `Produtos incluidos: ${input.totals.included}.`,
    input.error ? `Erro: ${input.error}` : "",
    ...(input.failures || []).map(({ sku, reason }) => `SKU ${sku || "nao identificado"} - ${reason || "Motivo nao informado"}.`)
  ].filter(Boolean).join("\n");

  try {
    await supabaseAdmin().from("pipeline_logs").insert({
      level: input.status === "failed" ? "error" : "info",
      message: input.process,
      payload: {
        stage: "stock_sync",
        process: input.process,
        status: input.status,
        summary,
        totals: input.totals,
        failures: input.failures || []
      }
    });
  } catch (error) {
    console.error("[synchronization_log]", error);
  }
}
