const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");

const source = fs.readFileSync("lib/product-action-rules.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleValue = { exports: {} };
vm.runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports, require });
const { getProductActionState } = moduleValue.exports;
const state = (...args) => JSON.parse(JSON.stringify(getProductActionState(...args)));

assert.deepEqual(state("TINY", ["a", "b", "c", "d"], { tinyProductId: null, marketplaceLinks: [] }),
  { showSave: false, showSend: true, saveBeforeSend: true });
assert.deepEqual(state("TINY", ["a", "b", "c", "d"], { tinyProductId: "123", marketplaceLinks: [] }),
  { showSave: true, showSend: false, saveBeforeSend: true });
assert.deepEqual(state("MARKETPLACE_DIRETO", ["a", "b", "c", "d"], { marketplaceLinks: [] }),
  { showSave: false, showSend: true, saveBeforeSend: true });
assert.deepEqual(state("MARKETPLACE_DIRETO", ["a", "b", "c", "d"], { marketplaceLinks: [{ accountId: "a", externalId: "ML1" }] }),
  { showSave: true, showSend: true, saveBeforeSend: true });
assert.deepEqual(state("MARKETPLACE_DIRETO", ["a", "b", "c", "d"], { marketplaceLinks: [
  { accountId: "a", externalId: "1" }, { accountId: "b", externalId: "2" }, { accountId: "c", externalId: "3" }, { accountId: "d", externalId: "4" }
] }), { showSave: true, showSend: false, saveBeforeSend: true });
assert.equal(getProductActionState("MARKETPLACE_DIRETO", ["a"], { marketplaceLinks: [{ accountId: "a", externalId: null }] }).showSend, true);

console.log("Regras dos botoes de produto validadas em 6 cenarios.");
