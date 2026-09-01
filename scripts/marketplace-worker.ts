import { loadEnvConfig } from "@next/env";
import { processMarketplaceQueue } from "../lib/marketplace-queue-worker";

loadEnvConfig(process.cwd());

const batchSize = integerEnv("MARKETPLACE_WORKER_BATCH_SIZE", 5, 1, 50);
const idleDelayMinMs = integerEnv("MARKETPLACE_WORKER_IDLE_MIN_MS", 2_000, 250, 60_000);
const idleDelayMaxMs = integerEnv("MARKETPLACE_WORKER_IDLE_MAX_MS", 30_000, idleDelayMinMs, 300_000);
const errorDelayMinMs = integerEnv("MARKETPLACE_WORKER_ERROR_MIN_MS", 5_000, 1_000, 300_000);
const errorDelayMaxMs = integerEnv("MARKETPLACE_WORKER_ERROR_MAX_MS", 60_000, errorDelayMinMs, 600_000);
const validateOnly = process.env.MARKETPLACE_WORKER_VALIDATE_ONLY === "1";

let running = true;
let wakeSleep: (() => void) | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    running = false;
    log("shutdown_requested", { signal });
    wakeSleep?.();
  });
}

export async function runMarketplaceWorker() {
  let emptyCycles = 0;
  let errorCycles = 0;

  log("worker_started", {
    pid: process.pid,
    batchSize,
    idleDelayMinMs,
    idleDelayMaxMs,
    errorDelayMinMs,
    errorDelayMaxMs
  });

  while (running) {
    const startedAt = Date.now();
    try {
      const result = await processMarketplaceQueue(batchSize);
      errorCycles = 0;

      if (result.claimed > 0) {
        emptyCycles = 0;
        log("batch_completed", {
          durationMs: Date.now() - startedAt,
          claimed: result.claimed,
          processed: result.processed,
          failed: result.failed
        });
        for (const item of result.results.filter((entry) => !entry.ok)) {
          log("activity_failed", item);
        }
        continue;
      }

      emptyCycles += 1;
      const delayMs = exponentialDelay(idleDelayMinMs, idleDelayMaxMs, emptyCycles);
      log("queue_empty", { delayMs, emptyCycles });
      await sleep(delayMs);
    } catch (error) {
      emptyCycles = 0;
      errorCycles += 1;
      const delayMs = exponentialDelay(errorDelayMinMs, errorDelayMaxMs, errorCycles);
      log("worker_cycle_error", {
        durationMs: Date.now() - startedAt,
        delayMs,
        error: errorMessage(error)
      });
      await sleep(delayMs);
    }
  }

  log("worker_stopped", { pid: process.pid });
}

function sleep(delayMs: number) {
  if (!running) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    wakeSleep = finish;

    function finish() {
      clearTimeout(timer);
      if (wakeSleep === finish) wakeSleep = null;
      resolve();
    }
  });
}

function exponentialDelay(minimum: number, maximum: number, attempt: number) {
  return Math.min(maximum, minimum * (2 ** Math.max(0, attempt - 1)));
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function log(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "marketplace-worker",
    event,
    ...details
  }));
}

if (validateOnly) {
  log("configuration_validated", {
    batchSize,
    idleDelayMinMs,
    idleDelayMaxMs,
    errorDelayMinMs,
    errorDelayMaxMs
  });
} else {
  runMarketplaceWorker().catch((error) => {
    log("worker_fatal_error", { error: errorMessage(error) });
    process.exitCode = 1;
  });
}
