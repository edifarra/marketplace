import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const anonKeyName = ["NEXT_PUBLIC_SUPABASE", "ANON_KEY"].join("_");
const anonKeyPattern = new RegExp(anonKeyName);

test("runtime administrativo nao aceita fallback para anon", () => {
  for (const relativePath of [
    "app/integracoes/page.tsx",
    "app/fotos/page.tsx",
    "lib/migration-stock.ts",
    "lib/auth.ts",
    "middleware.ts"
  ]) {
    assert.doesNotMatch(read(relativePath), anonKeyPattern, relativePath);
  }
});

test("paginas e migracao de estoque usam somente o cliente administrativo", () => {
  const integrations = read("app/integracoes/page.tsx");
  assert.match(integrations, /supabaseAdmin\(\)/);
  const settingsQuery = integrations.split("\n").find((line) => line.includes('.from("settings")')) || "";
  assert.doesNotMatch(settingsQuery, /TINY_TOKEN|OLIST_TINY_COOKIE/);
  assert.match(settingsQuery, /PRODUCT_SEND_TARGET.*ENVIAR_PRODUTOS_AUTOMATICO/);
  assert.match(read("app/fotos/page.tsx"), /supabaseAdmin\(\)/);
  assert.match(read("lib/migration-stock.ts"), /const supabase = supabaseAdmin\(\)/);
});

test("autenticacao exige service role explicitamente", () => {
  assert.match(read("lib/auth.ts"), /if \(!process\.env\.SUPABASE_SERVICE_ROLE_KEY\)/);
  const middleware = read("middleware.ts");
  assert.match(middleware, /const key = process\.env\.SUPABASE_SERVICE_ROLE_KEY;/);
  assert.doesNotMatch(middleware, /SERVICE_ROLE_KEY\s*\|\|/);
});

test("scripts administrativos nao referenciam a chave anon", () => {
  const scriptsRoot = path.join(root, "scripts");
  const files = fs.readdirSync(scriptsRoot, { recursive: true })
    .filter((entry) => /\.(?:[cm]?js|ts)$/.test(entry));

  for (const entry of files) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(scriptsRoot, entry), "utf8"),
      anonKeyPattern,
      path.join("scripts", entry)
    );
  }
});
