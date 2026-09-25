import assert from "node:assert/strict";
import test from "node:test";
import { classifyChanges } from "../scripts/smart-change-classifier.mjs";

const workerFiles = new Set([
  "scripts/marketplace-worker.ts",
  "lib/marketplace-queue-worker.ts",
  "lib/outgoing-activities.ts"
]);
const classify = (files) => classifyChanges(files, { workerFiles });

test("classifies frontend-only changes", () => {
  assert.deepEqual(pick(classify(["app/produtos/page.tsx"])), [true, false, false, false]);
});

test("classifies worker-only changes", () => {
  assert.deepEqual(pick(classify(["scripts/marketplace-worker.ts"])), [false, true, false, false]);
});

test("classifies frontend and worker through a shared module", () => {
  assert.deepEqual(pick(classify(["lib/outgoing-activities.ts"])), [true, true, false, false]);
});

test("classifies dependency changes for both runtimes", () => {
  const result = classifyChanges(["package.json"], { workerFiles, dependenciesChanged: true });
  assert.deepEqual(pick(result), [true, true, true, false]);
});

test("package scripts-only change does not affect either runtime by itself", () => {
  const result = classifyChanges(["package.json"], { workerFiles, dependenciesChanged: false });
  assert.deepEqual(pick(result), [false, false, false, false]);
});

test("detects migrations without inventing application changes", () => {
  assert.deepEqual(pick(classify(["supabase/migrations/091_example.sql"])), [false, false, false, true]);
});

test("test-only and documentation-only changes do not deploy", () => {
  assert.deepEqual(pick(classify(["tests/price-value.test.ts", "README.md"])), [false, false, false, false]);
});

test("unrelated lib change affects frontend but not worker", () => {
  assert.deepEqual(pick(classify(["lib/price-value.ts"])), [true, false, false, false]);
});

function pick(result) {
  return [result.frontend, result.worker, result.dependencies, result.migration];
}
