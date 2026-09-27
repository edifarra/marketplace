import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { cachedRoundLookup, createReconciliationRoundCache } from "../lib/marketplace-reconciliation-cache";

const source = fs.readFileSync(path.join(process.cwd(), "lib/marketplace-conversations.ts"), "utf8");
const shopeeSource = fs.readFileSync(path.join(process.cwd(), "lib/shopee.ts"), "utf8");

test("selects mínimos são específicos por fluxo", () => {
  assert.match(source, /conversationType === "post_sale"[\s\S]*?"id,conversation_path,pack_id,seller_id,raw_data"[\s\S]*?: "id,external_conversation_id,raw_data"/);
  const pendingShopee = source.slice(source.indexOf("async function pendingShopeeReconciliationRows"), source.indexOf("async function markMercadoLivreConversationReconciled"));
  assert.match(pendingShopee, /select\("id,external_conversation_id,raw_data"\)/);
  const orderLoader = source.slice(source.indexOf("async function loadOrderProducts"), source.indexOf("async function loadMercadoLivreBuyer"));
  assert.doesNotMatch(orderLoader, /venda_item\(sku,valor_unitario,raw_data\)/);
  assert.match(source, /MERCADO_LIVRE_PRODUCT_LOOKUP_SELECT/);
});

test("contexto Shopee reutiliza as credenciais carregadas com a conta", () => {
  assert.match(shopeeSource, /client_id,client_secret,redirect_uri,api_base_url/);
  const context = source.slice(source.indexOf("async function shopeeContext"), source.indexOf("function isClosedQuestion"));
  assert.match(context, /getShopeeOAuthConfig\(account\)/);
  assert.doesNotMatch(context, /getShopeeOAuthConfig\(account\.id\)/);
});

test("cache é local à rodada e hit evita lookup duplicado", async () => {
  const firstRound = createReconciliationRoundCache();
  let calls = 0;
  const load = async () => { calls += 1; return { id: "product" }; };
  const [first, second] = await Promise.all([
    cachedRoundLookup(firstRound.productsByListing, "account:item", load),
    cachedRoundLookup(firstRound.productsByListing, "account:item", load)
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);

  const secondRound = createReconciliationRoundCache();
  await cachedRoundLookup(secondRound.productsByListing, "account:item", load);
  assert.equal(calls, 2);
  assert.notEqual(firstRound.productsByListing, secondRound.productsByListing);
});
