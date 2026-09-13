import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
test("executor descartável tem escopo rígido e não acessa assets reais",()=>{const source=fs.readFileSync(new URL("../scripts/cloudinary-stage2-rollback-test.mjs",import.meta.url),"utf8");assert.match(source,/testes\\\/cloudinary-stage2-rollback-/);assert.match(source,/--execute-disposable-test/);assert.doesNotMatch(source,/cloudinary-legacy-optimize\.mjs --execute/);assert.doesNotMatch(source,/\.from\([^)]*\)\.update|\.from\([^)]*\)\.delete|\.from\([^)]*\)\.insert/)});
