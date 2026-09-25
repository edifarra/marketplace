import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { deploymentMode, mayModifyExternalEnvironment } from "../scripts/smart-execution-policy.mjs";

test("planning mode cannot modify external environments", () => {
  const mode = deploymentMode({ execute: false, dryRun: false });
  assert.equal(mode, "plan");
  assert.equal(mayModifyExternalEnvironment(mode), false);
});

test("dry-run cannot modify external environments", () => {
  const mode = deploymentMode({ execute: false, dryRun: true });
  assert.equal(mode, "dry-run");
  assert.equal(mayModifyExternalEnvironment(mode), false);
});

test("dry-run remains safe even when combined with --execute", () => {
  const mode = deploymentMode({ execute: true, dryRun: true });
  assert.equal(mode, "dry-run");
  assert.equal(mayModifyExternalEnvironment(mode), false);
});

test("only explicit execute mode can modify external environments", () => {
  const mode = deploymentMode({ execute: true, dryRun: false });
  assert.equal(mode, "execute");
  assert.equal(mayModifyExternalEnvironment(mode), true);
});

test("smart validation contains no production action", () => {
  const source = fs.readFileSync(new URL("../scripts/smart-check.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:vercel|ssh)\b|supabase\s+db\s+push|smart-deploy/i);
});

test("validation package scripts do not invoke deployment", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const script of ["check:smart", "typecheck", "build", "test:smart-change-classifier"]) {
    assert.doesNotMatch(packageJson.scripts[script], /deploy/i, `${script} must not invoke deployment`);
  }
});
