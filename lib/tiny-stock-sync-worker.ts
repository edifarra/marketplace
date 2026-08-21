import { getTinyStockSyncProgress, stepTinyStockSync } from "./tiny-stock-sync";

const WORK_WINDOW_MS = 42_000;
// Cada produto exige duas chamadas ao Tiny (cadastro e estoque). Mantemos o
// ritmo abaixo do limite da API para evitar bloqueios temporarios.
const STEP_INTERVAL_MS = 6_000;

export async function runTinyStockSyncWorker(origin: string) {
  const startedAt = Date.now();
  let progress = await getTinyStockSyncProgress();

  while (progress.status === "running" && Date.now() - startedAt < WORK_WINDOW_MS) {
    progress = await stepTinyStockSync();
    if (progress.status !== "running") return progress;
    await delay(STEP_INTERVAL_MS);
  }

  if (progress.status === "running") {
    await continueInAnotherInvocation(origin);
  }
  return progress;
}

async function continueInAnotherInvocation(origin: string) {
  const secret = process.env.CRON_SECRET || process.env.AUTH_SESSION_SECRET;
  if (!secret) throw new Error("Segredo interno indisponivel para continuar o sincronismo Tiny.");

  const response = await fetch(new URL("/api/estoque/sync/worker", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Falha ao continuar o sincronismo Tiny em segundo plano (${response.status}).`);
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
