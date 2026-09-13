#!/usr/bin/env node
import { parseCleanupArgs, runCleanup, safeError } from "../lib/cloudinary-orphan-cleanup.mjs";

try {
  const options = parseCleanupArgs(process.argv.slice(2));
  const result = await runCleanup({ ...options, root: process.cwd() });
  console.log(JSON.stringify({
    mode: options.mode,
    approved: result.approved.length,
    blocked: result.blocked.length,
    executed: result.executed.length,
    errors: result.totalErrors,
    protected_out_of_scope: result.protectedCount,
    duration_seconds: Number((result.durationMs / 1000).toFixed(1)),
    timeouts_by_source: result.timeoutsBySource
  }, null, 2));
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
