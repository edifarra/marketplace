import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(new URL("../app/configuracoes/frete-flex/actions.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/configuracoes/frete-flex/page.tsx", import.meta.url), "utf8");
const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");

test("Frete FLEX writes require a Master session on every server action", () => {
  const actionsFound = [...actions.matchAll(/export async function (\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(actionsFound.sort(), ["deleteFreteFlexCity", "saveFreteFlexCity", "saveFreteFlexConfiguration", "toggleFreteFlexCity"].sort());
  assert.equal((actions.match(/if \(!\(await requireMaster\(\)\)\) redirect\("\/acesso-negado"\);/g) || []).length, 4);
  assert.match(actions, /import \{ requireMaster \} from "@\/lib\/auth"/);
});

test("Frete FLEX page is login protected and renders city and tariff data server-side", () => {
  assert.match(page, /const user = await getCurrentUser\(\)/);
  assert.match(page, /if \(!user\) redirect\("\/login/);
  assert.match(page, /user\.isMaster/);
  assert.match(page, /\.from\("config_frete_flex"\)/);
  assert.match(page, /\.from\("config_frete_flex_cidades_extremo"\)/);
  assert.match(proxy, /if \(!user\) \{/);
});
